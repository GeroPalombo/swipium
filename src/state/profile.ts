import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseSnapshot } from '../snapshot/parse.js';
import { executeSeed, seedExactCommand } from '../flows/seedExec.js';
import { grantPermission, revokePermission } from '../lib/device.js';
import { privacySet } from '../lib/simctl.js';
import type { Driver } from '../drivers/Driver.js';
import type { Session, SessionStore } from '../session/store.js';

export interface StateProfile {
  name: string;
  appId?: string;
  appPath?: string;
  reset?: {
    android?: 'clearData' | 'none';
    ios?: 'reinstallApp' | 'none';
    appPath?: string;
    allowedOnDebugBundle?: boolean;
    requiresReleaseBuild?: boolean;
    acknowledgeBundleLossRisk?: boolean;
  };
  launch?: {
    clearState?: boolean;
    stopApp?: boolean;
    permissions?: Record<string, 'allow' | 'deny' | 'unset'>;
    arguments?: Record<string, unknown>;
  };
  seed?: Array<{ fixture: string }>;
  verify?: Array<{ assertVisible?: string }>;
  teardown?: Array<'networkOnline' | { networkOnline?: boolean }>;
}

export interface StateLedger {
  profile: string;
  status: 'state_prepared' | 'state_verified' | 'state_torn_down' | 'state_refused' | 'state_blocked';
  steps: Array<{ kind: string; status: 'ok' | 'skipped' | 'blocked' | 'refused'; detail?: string }>;
  seedTransactions?: StateSeedTransaction[];
  mutationPayloadHash?: string;
  startedAt: string;
  endedAt: string;
}

export interface StateSeedTransaction {
  fixture: string;
  phase: 'prepare' | 'cleanup';
  type: 'deeplink' | 'script' | 'api';
  exactCommand: string;
  status: 'ok' | 'blocked' | 'skipped';
  detail?: string;
  warnings?: string[];
  idempotency: 'declared_idempotent' | 'not_declared';
  cleanup: 'declared' | 'not_declared' | 'executed' | 'blocked';
  verification: {
    before: 'not_captured';
    after: 'declared_not_run' | 'not_declared';
  };
}

export function loadStateProfile(root: string, nameOrYaml: string): { profile?: StateProfile; error?: string; path?: string } {
  const candidates = nameOrYaml.includes('\n') || /name\s*:/.test(nameOrYaml)
    ? []
    : [join(root, '.swipium', 'state', `${nameOrYaml}.yaml`), join(root, '.swipium', 'state', `${nameOrYaml}.yml`)];
  const path = candidates.find((p) => existsSync(p));
  const text = path ? readFileSync(path, 'utf8') : nameOrYaml;
  try {
    const profile = parseYaml(text) as StateProfile;
    if (!profile?.name) return { error: 'state profile needs a name' };
    return { profile, path };
  } catch (e) {
    return { error: `could not parse state profile: ${String((e as Error).message ?? e)}` };
  }
}

const ANDROID_PERMISSION_ALIASES: Record<string, string[]> = {
  notifications: ['android.permission.POST_NOTIFICATIONS'],
  location: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
  camera: ['android.permission.CAMERA'],
  microphone: ['android.permission.RECORD_AUDIO'],
  contacts: ['android.permission.READ_CONTACTS'],
  photos: ['android.permission.READ_MEDIA_IMAGES'],
};

function permissionsFor(platform: 'android' | 'ios', name: string): string[] {
  if (platform === 'android') {
    if (name.startsWith('android.permission.')) return [name];
    return ANDROID_PERMISSION_ALIASES[name] ?? [`android.permission.${name.toUpperCase()}`];
  }
  return [name];
}

function resolveAppPath(session: Session, profile: StateProfile): string | undefined {
  const raw = profile.reset?.appPath ?? profile.appPath;
  if (!raw) return undefined;
  return isAbsolute(raw) ? raw : join(session.root, raw);
}

function hasLaunchArgs(profile: StateProfile): boolean {
  return !!profile.launch?.arguments && Object.keys(profile.launch.arguments).length > 0;
}

function resetPolicyRefusal(profile: StateProfile): string | null {
  const destructiveReset =
    profile.reset?.android === 'clearData' ||
    profile.reset?.ios === 'reinstallApp' ||
    profile.launch?.clearState === true;
  if (!destructiveReset) return null;
  if (profile.reset?.requiresReleaseBuild && !profile.reset.acknowledgeBundleLossRisk) return 'release-build reset requires acknowledgeBundleLossRisk:true';
  if (profile.reset?.allowedOnDebugBundle !== true && !profile.reset?.acknowledgeBundleLossRisk) return 'debug-bundle reset refused by state profile policy; reset.allowedOnDebugBundle defaults to false';
  return null;
}

function setBlocked(status: StateLedger['status']): StateLedger['status'] {
  return status === 'state_refused' ? status : 'state_blocked';
}

function setRefused(): StateLedger['status'] {
  return 'state_refused';
}

function seedTransaction(input: {
  fixture: string;
  phase: 'prepare' | 'cleanup';
  type: 'deeplink' | 'script' | 'api';
  exactCommand: string;
  ok: boolean;
  detail?: string;
  warnings?: string[];
  idempotent?: boolean;
  cleanup: StateSeedTransaction['cleanup'];
  profile: StateProfile;
}): StateSeedTransaction {
  return {
    fixture: input.fixture,
    phase: input.phase,
    type: input.type,
    exactCommand: input.exactCommand,
    status: input.ok ? 'ok' : 'blocked',
    detail: input.detail,
    warnings: input.warnings?.length ? input.warnings : undefined,
    idempotency: input.idempotent ? 'declared_idempotent' : 'not_declared',
    cleanup: input.cleanup,
    verification: { before: 'not_captured', after: (input.profile.verify?.length ?? 0) > 0 ? 'declared_not_run' : 'not_declared' },
  };
}

async function assertVisible(driver: Driver, query: string): Promise<boolean> {
  const q = query.toLowerCase();
  const parsed = parseSnapshot(await driver.dumpXml());
  return parsed.allNodes.some((n) => n.text.toLowerCase().includes(q) || n.desc.toLowerCase().includes(q) || n.id.toLowerCase().includes(q));
}

export async function prepareStateProfile(sessions: SessionStore, session: Session, driver: Driver, profile: StateProfile): Promise<StateLedger> {
  const steps: StateLedger['steps'] = [];
  const seedTransactions: StateSeedTransaction[] = [];
  const startedAt = new Date().toISOString();
  const appId = profile.appId ?? session.appId;
  let status: StateLedger['status'] = 'state_prepared';

  if (profile.reset && profile.reset.android === 'clearData') {
    const policyRefusal = resetPolicyRefusal(profile);
    if (!appId) {
      steps.push({ kind: 'reset.android.clearData', status: 'blocked', detail: 'no appId available' });
      status = 'state_blocked';
    } else if (policyRefusal) {
      steps.push({ kind: 'reset.android.clearData', status: 'refused', detail: policyRefusal });
      status = setRefused();
    } else {
      await driver.clearData(appId);
      sessions.addEnvChange(session, `state reset clearData ${appId}`);
      steps.push({ kind: 'reset.android.clearData', status: 'ok', detail: appId });
    }
  }

  if (profile.reset && profile.reset.ios === 'reinstallApp') {
    const appPath = resolveAppPath(session, profile);
    const policyRefusal = resetPolicyRefusal(profile);
    if (!appId) {
      steps.push({ kind: 'reset.ios.reinstallApp', status: 'blocked', detail: 'no appId available' });
      status = setBlocked(status);
    } else if (!appPath) {
      steps.push({ kind: 'reset.ios.reinstallApp', status: 'blocked', detail: 'profile.reset.appPath or profile.appPath is required' });
      status = setBlocked(status);
    } else if (policyRefusal) {
      steps.push({ kind: 'reset.ios.reinstallApp', status: 'refused', detail: policyRefusal });
      status = setRefused();
    } else if (!driver.uninstallApp) {
      steps.push({ kind: 'reset.ios.reinstallApp', status: 'blocked', detail: `${driver.kind} backend cannot uninstall apps` });
      status = setBlocked(status);
    } else {
      await driver.terminateApp(appId).catch(() => {});
      await driver.uninstallApp(appId).catch(() => {});
      await driver.installApp(appPath);
      sessions.addEnvChange(session, `state reset reinstallApp ${appId} from ${appPath}`);
      steps.push({ kind: 'reset.ios.reinstallApp', status: 'ok', detail: `${appId} from ${appPath}` });
    }
  }

  if (status !== 'state_refused' && status !== 'state_blocked' && profile.launch?.clearState) {
    const policyRefusal = resetPolicyRefusal(profile);
    if (!appId) {
      steps.push({ kind: 'launch.clearState', status: 'blocked', detail: 'no appId available' });
      status = setBlocked(status);
    } else if (policyRefusal) {
      steps.push({ kind: 'launch.clearState', status: 'refused', detail: policyRefusal });
      status = setRefused();
    } else if (driver.kind === 'direct') {
      await driver.clearData(appId);
      sessions.addEnvChange(session, `state launch.clearState ${appId}`);
      steps.push({ kind: 'launch.clearState', status: 'ok', detail: appId });
    } else {
      const appPath = resolveAppPath(session, profile);
      if (appPath && driver.uninstallApp) {
        await driver.terminateApp(appId).catch(() => {});
        await driver.uninstallApp(appId).catch(() => {});
        await driver.installApp(appPath);
        sessions.addEnvChange(session, `state launch.clearState reinstall ${appId}`);
        steps.push({ kind: 'launch.clearState', status: 'ok', detail: `reinstalled ${appId}` });
      } else {
        steps.push({ kind: 'launch.clearState', status: 'blocked', detail: 'non-Android clearState requires appPath and uninstall support' });
        status = setBlocked(status);
      }
    }
  }

  if (status !== 'state_refused' && status !== 'state_blocked' && profile.launch?.permissions && Object.keys(profile.launch.permissions).length) {
    if (!appId) {
      steps.push({ kind: 'permissions', status: 'blocked', detail: 'no appId available' });
      status = setBlocked(status);
    } else if (driver.kind === 'direct') {
      const serial = driver.currentDevice();
      if (!serial) {
        steps.push({ kind: 'permissions.android', status: 'blocked', detail: 'no adb serial available' });
        status = setBlocked(status);
      } else {
        for (const [name, desired] of Object.entries(profile.launch.permissions)) {
          for (const permission of permissionsFor('android', name)) {
            if (desired === 'allow') {
              await grantPermission(serial, appId, permission);
              sessions.addEnvChange(session, `state permission grant ${permission} to ${appId}`);
              steps.push({ kind: `permissions.android.${permission}`, status: 'ok', detail: 'grant' });
            } else if (desired === 'deny') {
              await revokePermission(serial, appId, permission);
              sessions.addEnvChange(session, `state permission revoke ${permission} from ${appId}`);
              steps.push({ kind: `permissions.android.${permission}`, status: 'ok', detail: 'revoke' });
            } else {
              steps.push({ kind: `permissions.android.${permission}`, status: 'blocked', detail: 'unset is not supported per-permission on Android' });
              status = setBlocked(status);
            }
          }
        }
      }
    } else if ((driver.kind === 'simulator' || driver.kind === 'wda') && driver.currentDevice()) {
      const udid = driver.currentDevice()!;
      for (const [name, desired] of Object.entries(profile.launch.permissions)) {
        for (const service of permissionsFor('ios', name)) {
          const action = desired === 'allow' ? 'grant' : desired === 'deny' ? 'revoke' : 'reset';
          await privacySet(udid, action, service, appId);
          sessions.addEnvChange(session, `state ios privacy ${action} ${service}${appId ? ` ${appId}` : ''}`);
          steps.push({ kind: `permissions.ios.${service}`, status: 'ok', detail: action });
        }
      }
    } else {
      steps.push({ kind: 'permissions', status: 'blocked', detail: `${driver.kind} backend cannot apply state-profile permissions` });
      status = setBlocked(status);
    }
  }

  if (status !== 'state_refused' && status !== 'state_blocked' && profile.launch) {
    if (!appId) {
      steps.push({ kind: 'launch', status: 'blocked', detail: 'no appId available' });
      status = 'state_blocked';
    } else {
      if (profile.launch.stopApp) await driver.terminateApp(appId).catch(() => {});
      if (hasLaunchArgs(profile)) {
        if (!driver.launchAppWithArgs) {
          steps.push({ kind: 'launch.arguments', status: 'blocked', detail: `${driver.kind} backend cannot launch with arguments` });
          status = 'state_blocked';
        } else {
          await driver.launchAppWithArgs(appId, profile.launch.arguments ?? {});
        }
      } else {
        await driver.launchApp(appId);
      }
      if (status !== 'state_blocked') {
        sessions.addEnvChange(session, `state launch ${appId}`);
        steps.push({ kind: 'launch', status: 'ok', detail: JSON.stringify({ arguments: profile.launch.arguments ?? null, permissions: profile.launch.permissions ?? null }) });
      }
    }
  }

  if (status !== 'state_refused' && status !== 'state_blocked') {
    for (const seed of profile.seed ?? []) {
      const fixture = session.fixtures.find((f) => f.name === seed.fixture);
      if (!fixture?.seed) {
        steps.push({ kind: `seed.${seed.fixture}`, status: 'blocked', detail: 'fixture has no seed spec' });
        status = 'state_blocked';
        continue;
      }
      const r = await executeSeed(sessions, session, driver, seed.fixture, fixture.seed);
      steps.push({ kind: `seed.${seed.fixture}`, status: r.ok ? 'ok' : 'blocked', detail: r.detail ?? r.warnings.join(' ') });
      seedTransactions.push(seedTransaction({
        fixture: seed.fixture,
        phase: 'prepare',
        type: fixture.seed.type,
        exactCommand: seedExactCommand(fixture.seed),
        ok: r.ok,
        detail: r.detail,
        warnings: r.warnings,
        idempotent: fixture.seed.idempotent,
        cleanup: fixture.seed.cleanup ? 'declared' : 'not_declared',
        profile,
      }));
      if (!r.ok) status = 'state_blocked';
    }
  }

  return { profile: profile.name, status, steps, seedTransactions: seedTransactions.length ? seedTransactions : undefined, startedAt, endedAt: new Date().toISOString() };
}

export async function verifyStateProfile(driver: Driver, profile: StateProfile): Promise<StateLedger> {
  const steps: StateLedger['steps'] = [];
  const startedAt = new Date().toISOString();
  let status: StateLedger['status'] = 'state_verified';
  for (const v of profile.verify ?? []) {
    if (!v.assertVisible) continue;
    const ok = await assertVisible(driver, v.assertVisible);
    steps.push({ kind: `verify.assertVisible.${v.assertVisible}`, status: ok ? 'ok' : 'blocked' });
    if (!ok) status = 'state_blocked';
  }
  return { profile: profile.name, status, steps, startedAt, endedAt: new Date().toISOString() };
}

export async function teardownStateProfile(sessions: SessionStore, session: Session, driver: Driver, profile: StateProfile): Promise<StateLedger> {
  const steps: StateLedger['steps'] = [];
  const seedTransactions: StateSeedTransaction[] = [];
  const startedAt = new Date().toISOString();
  let status: StateLedger['status'] = 'state_torn_down';
  for (const seed of [...(profile.seed ?? [])].reverse()) {
    const fixture = session.fixtures.find((f) => f.name === seed.fixture);
    const cleanup = fixture?.seed?.cleanup;
    if (!fixture?.seed || !cleanup) continue;
    const r = await executeSeed(sessions, session, driver, `${seed.fixture}-cleanup`, cleanup);
    steps.push({ kind: `seedCleanup.${seed.fixture}`, status: r.ok ? 'ok' : 'blocked', detail: r.detail ?? r.warnings.join(' ') });
    seedTransactions.push(seedTransaction({
      fixture: seed.fixture,
      phase: 'cleanup',
      type: cleanup.type,
      exactCommand: seedExactCommand(cleanup),
      ok: r.ok,
      detail: r.detail,
      warnings: r.warnings,
      idempotent: fixture.seed.idempotent,
      cleanup: r.ok ? 'executed' : 'blocked',
      profile,
    }));
    if (!r.ok) status = 'state_blocked';
  }
  for (const t of profile.teardown ?? []) {
    const networkOnline = t === 'networkOnline' || (typeof t === 'object' && t.networkOnline);
    if (networkOnline) {
      await driver.setAirplane(false);
      sessions.addEnvChange(session, `state teardown networkOnline ${profile.name}`);
      steps.push({ kind: 'teardown.networkOnline', status: 'ok' });
    }
  }
  return { profile: profile.name, status, steps, seedTransactions: seedTransactions.length ? seedTransactions : undefined, startedAt, endedAt: new Date().toISOString() };
}
