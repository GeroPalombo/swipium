// Android prepare service (hardening P0.1) — boot (if needed) → reverse → install → launch,
// extracted from qa_prepare_target's job worker so qa_test_this execute mode runs the SAME path
// without going through the MCP transport. Returns a structured result + drives progress via a
// callback; the caller maps it to a job. Behaviour mirrors the original worker exactly.

import type { ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import {
  adbDevices, bootEmulator, waitForBoot, resolveApk,
  deviceFreeDataBytes, deviceAbis, apkNativeAbis, fmtBytes,
  apkMinSdk, deviceSdk, minSdkCompatible, classifyAndroidInstallError,
} from '../lib/android.js';
import { metroReadiness } from '../lib/metroState.js';
import { log } from '../lib/logger.js';
import type { DirectDriver } from '../drivers/DirectDriver.js';
import type { Session, SessionStore } from '../session/store.js';

export interface PrepareAndroidArgs {
  needBoot: boolean;
  bootTarget?: string;
  serial?: string;
  resolvedAppId: string;
  apkPath?: string;
  apk?: string;
  force?: boolean;
  headless?: boolean;
  rnDebug?: boolean;
  allowLaunchWithoutMetro?: boolean;
  bindOnly?: boolean;
  mutationConsent?: { required: boolean; consentId?: string; approved: boolean; payloadHash?: string };
}

export interface PrepareAndroidResult {
  ok: boolean;
  aborted?: boolean;
  failureCode?: string;
  error?: string;
  device?: string;
  appId?: string;
  installed?: string;
  foreground?: string;
  launchedOk?: boolean;
  display?: string;
  bound?: boolean;
  metro?: Awaited<ReturnType<typeof metroReadiness>>;
  result?: Record<string, unknown>;
  resultText?: string;
}

export interface PrepareCtx {
  signal?: AbortSignal;
  onProgress?: (text: string) => void;
}

/** Boot/install/launch an Android app on a device. Mirrors the original prepareTarget worker. */
export async function prepareAndroid(
  sessions: SessionStore,
  session: Session,
  driver: DirectDriver,
  a: PrepareAndroidArgs,
  ctx: PrepareCtx = {},
): Promise<PrepareAndroidResult> {
  const { signal } = ctx;
  const progress = (text: string) => ctx.onProgress?.(text);
  const aborted = () => signal?.aborted ?? false;
  let emu: ChildProcess | undefined;
  try {
    let serial = a.serial;
    if (a.needBoot && a.bootTarget) {
      progress(`booting ${a.bootTarget}`);
      session.headless = a.headless ?? true;
      emu = bootEmulator(a.bootTarget, a.headless ?? true);
      signal?.addEventListener('abort', () => {
        try {
          emu?.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      });
      sessions.milestone(session, 'simulator_boot_start');
      for (let i = 0; i < 60 && !serial; i++) {
        if (aborted()) return { ok: false, aborted: true };
        const d = await adbDevices();
        if (d.length) serial = d[0];
        else await new Promise((r) => setTimeout(r, 2000));
      }
      if (!serial) return { ok: false, failureCode: 'EMULATOR_BOOT_FAILED', error: 'emulator did not appear' };
      const booted = await waitForBoot(serial, 180000);
      if (!booted) return { ok: false, failureCode: 'EMULATOR_BOOT_FAILED', error: `emulator "${a.bootTarget}" did not finish booting` };
      sessions.milestone(session, 'simulator_boot_end');
      sessions.recordMutation(session, {
        tool: 'qa_prepare_target',
        action: 'boot_emulator',
        risk: 'low',
        target: { avd: a.bootTarget, headless: a.headless ?? true, device: serial },
        consent: a.mutationConsent ?? { required: false, approved: true },
        status: 'executed',
      });
    }
    if (!serial) return { ok: false, failureCode: 'NO_DEVICE', error: 'no device' };
    if (aborted()) return { ok: false, aborted: true };

    driver.useDevice(serial);
    session.device = serial; // bind early so all tools agree
    session.driver = driver;
    sessions.persist(session);
    await driver.disableAnimations().catch(() => {});

    if (a.rnDebug) {
      try {
        await driver.adbReverseMetro();
        sessions.addEnvChange(session, 'set adb reverse tcp:8081');
      } catch {
        /* best-effort */
      }
    }

    if (a.bindOnly) {
      const rd = await metroReadiness(serial);
      return { ok: true, bound: true, device: serial, metro: rd, resultText: `Bound ${serial} (bindOnly). ${a.rnDebug ? `Metro serving=${rd.serving} reverse=${rd.reverseSet} ready=${rd.ready}.` : ''}`, result: { device: serial, bound: true, metro: rd } };
    }

    const installed = await driver.isInstalled(a.resolvedAppId);
    if (!installed || a.force) {
      let apkPath = a.apkPath;
      if (!apkPath) {
        const r = resolveApk(session.root, a.apk);
        if (!r.apk) return { ok: false, failureCode: 'NO_ARTIFACT', error: r.error ?? 'no APK to install' };
        apkPath = r.apk;
      }
      const apkSize = statSync(apkPath).size;
      const free = await deviceFreeDataBytes(serial);
      if (free != null && free < apkSize * 1.3) {
        return { ok: false, failureCode: 'INSTALL_FAILED', error: `not enough space: APK ~${fmtBytes(apkSize)}, /data free ${fmtBytes(free)}. Reboot emulator with \`-wipe-data -partition-size 8192\`.` };
      }
      const apkAbis = await apkNativeAbis(apkPath);
      if (apkAbis.length) {
        const devAbis = await deviceAbis(serial);
        if (devAbis.length && !apkAbis.some((x) => devAbis.includes(x))) {
          return { ok: false, failureCode: 'APK_ARCH_INCOMPATIBLE', error: `ABI mismatch: apk=[${apkAbis.join(',')}] device=[${devAbis.join(',')}]` };
        }
      }
      // minSdk preflight: catch "APK needs a newer Android than this device" before install,
      // so the blocker is ANDROID_MIN_SDK_INCOMPATIBLE (pick a newer device / lower minSdk),
      // not an opaque INSTALL_FAILED. Unknown values don't block (don't fail on missing aapt2).
      const [apkMin, devSdk] = await Promise.all([apkMinSdk(apkPath), deviceSdk(serial)]);
      if (!minSdkCompatible(apkMin, devSdk)) {
        return { ok: false, failureCode: 'ANDROID_MIN_SDK_INCOMPATIBLE', error: `APK minSdk ${apkMin} > device API level ${devSdk}. Use a device/emulator with API ${apkMin}+ or lower minSdkVersion.` };
      }
      progress('installing');
      if (aborted()) return { ok: false, aborted: true };
      sessions.milestone(session, 'app_install_start');
      try {
        await driver.installApp(apkPath);
      } catch (err) {
        const code = classifyAndroidInstallError(String(err));
        sessions.recordMutation(session, {
          tool: 'qa_prepare_target',
          action: 'install_app',
          risk: a.mutationConsent?.required ? 'medium' : 'low',
          target: { device: serial, appId: a.resolvedAppId, apkPath },
          consent: a.mutationConsent ?? { required: false, approved: true },
          status: 'blocked',
          detail: `${code}: ${String(err)}`,
        });
        return { ok: false, failureCode: code, error: `Install failed: ${String(err)}`, device: serial, appId: a.resolvedAppId };
      }
      sessions.milestone(session, 'app_install_end');
      sessions.recordMutation(session, {
        tool: 'qa_prepare_target',
        action: 'install_app',
        risk: a.mutationConsent?.required ? 'medium' : 'low',
        target: { device: serial, appId: a.resolvedAppId, apkPath, force: !!a.force },
        consent: a.mutationConsent ?? { required: false, approved: true },
        status: 'executed',
      });
    }

    if (aborted()) return { ok: false, aborted: true };
    if (a.rnDebug && !a.allowLaunchWithoutMetro) {
      const rd = await metroReadiness(serial);
      if (!rd.serving) {
        return { ok: false, failureCode: 'METRO_REQUIRED', error: `Debug RN/Expo build; Metro is not serving (listening=${rd.listening} serving=${rd.serving}) and the app would RedBox. Start the Metro/dev server, wait until it is serving, then retry.` };
      }
    }
    if (a.rnDebug && a.allowLaunchWithoutMetro) sessions.addEnvChange(session, 'OVERRIDE allowLaunchWithoutMetro — launched without confirmed Metro readiness');
    progress('launching');
    sessions.milestone(session, 'app_launch_start');
    await driver.launchApp(a.resolvedAppId);
    await new Promise((r) => setTimeout(r, 2500));
    const foreground = await driver.foregroundOwner();
    sessions.milestone(session, 'app_launch_end');
    sessions.recordMutation(session, {
      tool: 'qa_prepare_target',
      action: 'launch_app',
      risk: 'low',
      target: { device: serial, appId: a.resolvedAppId, foreground },
      consent: { required: false, approved: true },
      status: 'executed',
    });
    session.device = serial;
    session.appId = a.resolvedAppId;
    session.driver = driver;

    const launchedOk = foreground.startsWith(a.resolvedAppId);
    const display = a.needBoot ? (session.headless ? 'headless' : 'visible window') : 'pre-existing device';
    const looksDebug = /debug|\bdev\b/i.test(a.apkPath ?? a.apk ?? '');
    const metroHint = looksDebug ? 'Looks like a debug build. If a Metro/dev-server error appears, start Metro manually and retry.' : undefined;
    const result = {
      device: serial, appId: a.resolvedAppId,
      installed: installed && !a.force ? 'already-present' : 'installed-now',
      foreground, launchedOk, display, ...(metroHint ? { metroHint } : {}),
    };
    const viewHint = a.needBoot && session.headless ? ` (headless — view with: scrcpy -s ${serial})` : '';
    return {
      ok: true, device: serial, appId: a.resolvedAppId, installed: result.installed, foreground, launchedOk, display,
      result, resultText: `${launchedOk ? '✅' : '⚠️'} ${a.resolvedAppId} on ${serial} [${display}${viewHint}]; foreground=${foreground}.${metroHint ? '\n' + metroHint : ''}`,
    };
  } catch (e) {
    if (aborted()) return { ok: false, aborted: true };
    log('error', 'prepareAndroid failed', { err: String(e) });
    return { ok: false, failureCode: 'APP_LAUNCH_FAILED', error: String(e) };
  }
}
