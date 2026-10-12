import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { isAbortError, runWithSignal } from '../lib/abortScope.js';
import { consumeConsent, isOperatorPreapproved, requireConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { run } from '../lib/spawn.js';
import { ensureGitignored } from '../lib/gitignore.js';
import {
  checkWda,
  classifyWdaBuildFailure,
  classifyWdaConnectionFailure,
  createWdaSession,
  discoverAppiumWdaProjects,
  findWdaXctestrun,
  discoverWdaProjectsWithAppium,
  managedWdaBuildArgs,
  managedWdaStartArgs,
  waitForWdaReady,
  wdaSessionUdidMismatch,
  xcodeAvailable,
  isLoopbackWdaUrl,
  isSimulatorUdid,
  remoteWdaAllowedByUser,
  REMOTE_WDA_ENV,
  type WdaStatus,
} from '../lib/wda.js';
import { loadWdaConfig, wdaSigningStatus, wdaUrlAllowedByConfig } from '../lib/wdaConfig.js';
import { findOwnSimulatorWda, freeWdaPort, managedWdaEnv, wdaDeviceOwnership, wdaUrlPort, wdaUrlWithPort } from '../lib/wdaDevice.js';
import { recordWdaTiming, wdaRecommendations, wdaTimingSummary } from '../lib/wdaTune.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import * as sim from '../lib/simctl.js';
import { resolveSimulatorArg, simulatorPinRefusal } from './ios.js';
import {
  findManagedWdaProcesses,
  killManagedWda,
  reclaimPid,
  registerManagedProcess,
  registeredWdaForSession,
  registeredWdasForDevice,
  reservedWdaPorts,
  unregisterManagedProcess,
  type ManagedWdaSignature,
} from '../session/processRegistry.js';
import type { ArtifactRecord, JobRecord, Session, SessionStore } from '../session/store.js';

/** qa_wda actions that run xcodebuild and are consent-gated as `wda_<name>` (CONSENT_ACTIONS in consent.ts).
 *  `setup` runs both and reuses those consents (wda_build when it must build, else wda_start). */
export const WDA_XCODEBUILD_ACTIONS = ['build', 'start'] as const;
function isWdaXcodebuildAction(a: string): a is (typeof WDA_XCODEBUILD_ACTIONS)[number] | 'setup' {
  return (WDA_XCODEBUILD_ACTIONS as readonly string[]).includes(a) || a === 'setup';
}

/** How long `qa_wda start` blocks inside ONE tool call waiting for /status. One call must stay
 *  under common client tool timeouts (Codex: 60 s), so a slower start returns status:"starting"
 *  and the agent polls with qa_wait { for:"wda_ready" } (bounded by ios.wda.startupTimeoutMs). */
export const WDA_START_CALL_WAIT_MS = 45_000;
/** Kill timer for the background `qa_wda build` job (a cold WDA build-for-testing is slow). */
export const WDA_BUILD_TIMEOUT_MS = 600_000;

const managedProcesses = new Map<string, { pid: number; logUri: string; logPath: string; url: string; startedAt: number }>();

/** The `managedProcess` field of qa_wda status (pid + log only, no local paths). */
function managedProcessSummary(sessionId: string): { pid: number; logUri: string } | null {
  const p = managedProcesses.get(sessionId);
  return p ? { pid: p.pid, logUri: p.logUri } : null;
}

function pidIsAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The registered (adopted) WDA for this session, or at `url` for simulator `udid` when its own
 *  session is gone; never one another live session of this server started. */
function adoptedWda(sessionId: string, url: string, udid: string | undefined) {
  const e = registeredWdaForSession(sessionId, url, udid);
  return e && [...managedProcesses].some(([sid, p]) => sid !== sessionId && p.pid === e.pid) ? undefined : e;
}

interface LiveManagedWda {
  pid: number;
  adopted: boolean;
  url?: string;
  startedAt?: number;
  logPath?: string;
  entry?: ReturnType<typeof registeredWdaForSession>;
}

/** A managed WDA this server still runs for the session (started here, or adopted at startup).
 *  A dead in-memory entry is dropped. */
function liveManagedWda(sessionId: string, url: string, udid: string | undefined): LiveManagedWda | undefined {
  const own = managedProcesses.get(sessionId);
  if (own) {
    if (pidIsAlive(own.pid)) return { pid: own.pid, adopted: false, url: own.url, startedAt: own.startedAt, logPath: own.logPath };
    managedProcesses.delete(sessionId);
    unregisterManagedProcess(own.pid);
  }
  const adopted = adoptedWda(sessionId, url, udid);
  return adopted && pidIsAlive(adopted.pid)
    ? { pid: adopted.pid, adopted: true, url: adopted.endpoint, startedAt: adopted.startedAt, entry: adopted }
    : undefined;
}

/** When the WDA runner dies (crash, kill -9) its parent `xcodebuild test-without-building`
 *  can live on for a long time, so a live pid alone does not mean a working WDA. It is stale when
 *  its URL refuses connections (a timeout is a busy WDA, not a dead one) and it either served
 *  before (its log has WDA's ServerURLHere line) or is older than the startup timeout. */
async function managedWdaIsStale(running: LiveManagedWda, startupTimeoutMs: number): Promise<boolean> {
  if (!running.url) return false;
  const status = await checkWda(running.url, 1500);
  if (status.reachable || /abort|timeout|timed out/i.test(status.error ?? '')) return false;
  if (running.startedAt !== undefined && Date.now() - running.startedAt > startupTimeoutMs) return true;
  try {
    return !!running.logPath && readFileSync(running.logPath, 'utf8').slice(-200_000).includes('ServerURLHere');
  } catch {
    return false;
  }
}

/** Stop a stale managed WDA found by liveManagedWda (own: its process group; adopted:
 *  fingerprint-checked) and forget it. */
function stopStaleManagedWda(sessionId: string, running: LiveManagedWda): void {
  if (running.adopted) {
    if (running.entry) reclaimPid(running.pid, 'wda', undefined, running.entry);
  } else {
    killManagedWda(running.pid);
    managedProcesses.delete(sessionId);
  }
  unregisterManagedProcess(running.pid);
}

/** The managed-WDA signature of this session's latest successful `qa_wda start` (from the
 *  mutation ledger, which survives a server restart). Lets `qa_wda stop` find the xcodebuild
 *  even when its process-registry entry was lost. Exported for tests. */
export function lastManagedWdaStart(session: Pick<Session, 'mutations'>): ManagedWdaSignature | undefined {
  const m = [...(session.mutations ?? [])]
    .reverse()
    .find((r) => r.tool === 'qa_wda' && r.action === 'wda_start' && r.status === 'executed' && typeof r.target?.projectPath === 'string');
  if (!m) return undefined;
  const t = m.target as { projectPath: string; udid?: unknown; derivedDataPath?: unknown; webDriverAgentUrl?: unknown };
  if (typeof t.udid !== 'string' || !t.udid) return undefined;
  let port: number | undefined;
  try {
    const u = new URL(String(t.webDriverAgentUrl ?? ''));
    port = Number(u.port) || undefined;
  } catch {
    port = undefined;
  }
  return {
    projectPath: t.projectPath,
    udid: t.udid,
    ...(typeof t.derivedDataPath === 'string' && t.derivedDataPath ? { derivedDataPath: t.derivedDataPath } : {}),
    ...(port ? { port } : {}),
  };
}

/** Where a WDA that `qa_wda stop` found by simulator in the process registry came from (round-4
 *  note: it said "started by another server run" for a WDA this same server started from another
 *  session). An entry this server owns was started or adopted by it for another session (the
 *  session's own entry is matched first); any other entry belongs to another server. Exported for tests. */
export function wdaStopOrigin(entries: Array<{ serverPid: number }>, serverPid: number = process.pid): string {
  const ours = entries.filter((e) => e.serverPid === serverPid).length;
  if (ours === entries.length) return 'registered by this server for another session';
  if (ours === 0) return 'registered by another Swipium server';
  return 'registered by this server for another session and by another Swipium server';
}

/** The WDA URL to probe for this session: the attached WdaDriver's, else the URL of the latest
 *  executed `qa_wda start` / reuse (both already passed the loopback/consent gate; a managed WDA
 *  may run on its own per-simulator port), else the configured one (source 'config': the caller
 *  must apply the non-loopback gate). Exported for qa_wait. */
export function wdaUrlForSession(session: Session): { url: string; source: 'driver' | 'wda_start' | 'config'; udid?: string } {
  if (session.driver instanceof WdaDriver) return { url: session.driver.baseUrl, source: 'driver' };
  const m = [...(session.mutations ?? [])]
    .reverse()
    .find(
      (r) =>
        r.tool === 'qa_wda' &&
        (r.action === 'wda_start' || r.action === 'wda_reuse') &&
        r.status === 'executed' &&
        typeof r.target?.webDriverAgentUrl === 'string',
    );
  // The simulator that start / reuse was for, so a later qa_wda call without `device` targets it
  // (IOS NEW: setup {device} then a bare attach was refused as ambiguous).
  const udid = typeof m?.target?.udid === 'string' ? m.target.udid : undefined;
  if (m) return { url: String(m.target!.webDriverAgentUrl), source: 'wda_start', ...(udid ? { udid } : {}) };
  return { url: loadWdaConfig(session.root).url, source: 'config' };
}

interface WdaDiagnosticIssue {
  code: string;
  severity: 'blocker' | 'warn';
  detail: string;
  nextStep: string;
  failureCode?: string;
}

const isLoopback = isLoopbackWdaUrl;

function latestWdaArtifacts(session: Session): {
  latestLog: ArtifactRecord | null;
  latestBuildLog: ArtifactRecord | null;
  latestStartLog: ArtifactRecord | null;
  latestErrorLog: ArtifactRecord | null;
} {
  const logs = [...session.artifacts].reverse().filter((a) => a.kind === 'wda');
  const latestBuildLog = logs.find((a) => /build/i.test(a.label ?? a.path)) ?? null;
  const latestStartLog = logs.find((a) => /start/i.test(a.label ?? a.path)) ?? null;
  const latestErrorLog = logs.find((a) => /failed|error/i.test(a.label ?? '')) ?? null;
  return { latestLog: logs[0] ?? null, latestBuildLog, latestStartLog, latestErrorLog };
}

function issue(
  code: string,
  detail: string,
  nextStep: string,
  severity: WdaDiagnosticIssue['severity'] = 'blocker',
  failureCode?: string,
): WdaDiagnosticIssue {
  return { code, severity, detail, nextStep, failureCode };
}

function latestErrorFailure(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try {
    const log = readFileSync(path, 'utf8').slice(-120_000);
    return classifyWdaBuildFailure(log);
  } catch {
    return undefined;
  }
}

function managedWdaBuildProductStatus(derivedDataPath: string): { built: boolean; productPath?: string; checkedPath: string } {
  const maxDepth = 6;
  const seen = new Set<string>();
  const stack: Array<{ path: string; depth: number }> = [{ path: derivedDataPath, depth: 0 }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur.path) || cur.depth > maxDepth) continue;
    seen.add(cur.path);
    let entries: string[];
    try {
      entries = readdirSync(cur.path);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur.path, name);
      if (/WebDriverAgentRunner.*\.app$/i.test(name)) return { built: true, productPath: p, checkedPath: derivedDataPath };
      try {
        if (statSync(p).isDirectory()) stack.push({ path: p, depth: cur.depth + 1 });
      } catch {
        // Ignore races or unreadable derived-data entries; doctor should stay best-effort.
      }
    }
  }
  return { built: false, checkedPath: derivedDataPath };
}

export function registerWda(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_wda',
    {
      title: 'iOS WebDriverAgent setup and control',
      description:
        'Set up and manage iOS WebDriverAgent (WDA), needed for structured iOS tap/type/snapshot; start with action:"setup": it reuses ' +
        'a running WDA, else builds (if no build exists) and starts it as one consent-gated job (poll qa_job_status, then qa_wda ' +
        'attach). build/start are consent-gated; attach takes an external webDriverAgentUrl; status/doctor/diagnose/logs/tune inspect.',
      inputSchema: {
        sessionId: z.string(),
        action: z
          .enum(['status', 'doctor', 'setup', 'build', 'start', 'stop', 'attach', 'diagnose', 'logs', 'tune'])
          .describe(
            'build: background job, reuses a build unless rebuild:true. start: waits up to 45 s, then status:"starting" (poll qa_wait for:"wda_ready").',
          ),
        webDriverAgentUrl: z.string().optional().describe('Default http://127.0.0.1:8100; non-loopback needs allowNonLoopback + consent.'),
        device: z.string().optional().describe('Simulator UDID (default: session device).'),
        udid: z.string().optional().describe('Deprecated alias of device.'),
        bundleId: z.string().optional().describe('Default: the session appId.'),
        wdaProjectPath: z.string().optional().describe('WebDriverAgent.xcodeproj (default: Appium WDA if found).'),
        derivedDataPath: z.string().optional().describe('xcodebuild -derivedDataPath for reuse.'),
        scheme: z.string().optional().describe('Default WebDriverAgentRunner.'),
        rebuild: z.boolean().optional().describe('build/setup: run build-for-testing even when a previous build (.xctestrun) exists.'),
        allowNonLoopback: z.boolean().optional().describe('Required to use a non-loopback external WDA URL.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({
      sessionId,
      action,
      webDriverAgentUrl,
      device,
      udid: udidAlias,
      bundleId,
      wdaProjectPath,
      derivedDataPath,
      scheme,
      rebuild,
      allowNonLoopback,
      consentId,
      approve,
    }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      // `device` is canonical (as on every other tool); `udid` is the deprecated alias.
      if (device && udidAlias && device !== udidAlias)
        return qaError({
          what: `Conflicting device "${device}" and udid "${udidAlias}"; udid is a deprecated alias of device`,
          changedState: false,
          retrySafe: true,
          failureCode: 'INVALID_ARGUMENT',
          nextSteps: ['Pass only device.'],
        });
      let udid = device ?? udidAlias;
      // A simulator name is resolved to its UDID first, so the SWIPIUM_DEVICE pin and the
      // session-device check below apply to it (it used to reach xcodebuild as `-destination id=<name>`).
      if (udid && !isSimulatorUdid(udid)) {
        const r = await resolveSimulatorArg(udid);
        if ('error' in r) return r.error;
        udid = r.udid;
      }

      const configured = loadWdaConfig(session.root);
      // Default: the WDA this session already uses (attached, or started/reused on its own
      // per-simulator port), else the configured URL.
      const sessionUrl = webDriverAgentUrl ? undefined : wdaUrlForSession(session);
      let url = webDriverAgentUrl ?? sessionUrl!.url;
      // The session's attached remote WDA already passed the gate below, so read-only actions on it
      // (status, logs, diagnose, ...) are not asked again. Each approval is single-use, so attach /
      // start / setup on a remote URL ask again, and a URL only recorded in the ledger (wda_start /
      // wda_reuse) never counts as approved.
      const gatedBefore = !!sessionUrl && sessionUrl.source === 'driver' && action !== 'attach' && !isWdaXcodebuildAction(action);
      const loopback = isLoopback(url) || gatedBefore;
      // Only the USER can pre-approve a remote WDA (env var in the MCP client config). The repo's
      // .swipium/config.json (ios.wda.url / allowNonLoopbackUrls) arrives with the checkout, so it
      // can never skip the per-call consent.
      const userAllowed = !loopback && remoteWdaAllowedByUser(url);
      const repoListed = !loopback && wdaUrlAllowedByConfig(configured, url);
      if (!loopback && !allowNonLoopback && !userAllowed) {
        return qaError({
          what: `Refused non-loopback WDA URL ${url}${webDriverAgentUrl ? '' : ' (from the repository config .swipium/config.json)'}`,
          changedState: false,
          retrySafe: false,
          failureCode: 'DESTRUCTIVE_REFUSED',
          nextSteps: [
            `Use a localhost WDA URL, pass allowNonLoopback:true and approve the consent prompt, or (user-level, trusted isolated network only) set ${REMOTE_WDA_ENV}=<exact url> in the MCP server environment.`,
            ...(repoListed ? ['ios.wda.allowNonLoopbackUrls in the repository config no longer pre-approves a remote WDA.'] : []),
          ],
        });
      }
      if (!loopback && !userAllowed) {
        const gate = consumeConsent(consentId, approve, { action: 'wda_non_loopback', affects: { url } });
        if (!gate.approved) {
          return requireConsent({
            action: 'wda_non_loopback',
            risk: 'medium',
            exactCommand: `connect to WebDriverAgent at ${url}`,
            affects: { url },
            explain: `Use non-loopback WebDriverAgent URL ${url}${webDriverAgentUrl ? '' : ' (configured by the repository (.swipium/config.json), unreviewed)'}? WDA is an automation server that receives app screens and typed text; only approve this on a trusted, isolated network.`,
          });
        }
      }

      const resolvePath = (p: string | undefined) => (p ? (isAbsolute(p) ? p : join(session.root, p)) : undefined);
      const explicitProjectPath = resolvePath(wdaProjectPath);
      // Managed build/start without wdaProjectPath: use a user-installed Appium WebDriverAgent
      // (~/.appium/…/appium-webdriveragent, global npm), reported as wdaProjectSource.
      const discoveredAppiumProject = !explicitProjectPath && isWdaXcodebuildAction(action) ? discoverAppiumWdaProjects()[0] : undefined;
      const projectPath = explicitProjectPath ?? discoveredAppiumProject;
      const wdaProjectSource = explicitProjectPath ? 'argument' : discoveredAppiumProject ? 'appium-discovered' : null;
      const ddPath = resolvePath(derivedDataPath) ?? configured.derivedDataPath;
      // What this call actually uses (args over config), echoed as `wdaConfig` so a passed
      // derivedDataPath / webDriverAgentUrl is not misreported as the configured default.
      const effectiveConfig = { ...configured, url, derivedDataPath: ddPath };
      const targetUdid = udid ?? session.device ?? sessionUrl?.udid;
      if (udid && session.device && udid !== session.device) {
        return qaError({
          what: `Refused ambiguous WDA/device mapping: session is bound to ${session.device}, but qa_wda was asked to use ${udid}`,
          changedState: false,
          retrySafe: false,
          failureCode: 'STALE_WDA_DEVICE',
          nextSteps: ['Use the session-bound UDID, or start a separate session for the other simulator/device.'],
        });
      }
      // A pinned server never starts, reuses, attaches or stops a WDA on another simulator.
      if (targetUdid && isSimulatorUdid(targetUdid) && (isWdaXcodebuildAction(action) || action === 'attach' || action === 'stop')) {
        const refusal = await simulatorPinRefusal(targetUdid);
        if (refusal) return refusal;
      }

      if (action === 'logs') {
        if (session.sensitive) return sensitiveRefusal('WDA logs');
        const logs = [...session.artifacts].reverse().filter((a) => a.kind === 'wda');
        const { latestLog: latest, latestBuildLog, latestStartLog, latestErrorLog } = latestWdaArtifacts(session);
        return qaOk(
          {
            logs: logs.map((a) => ({ uri: a.uri, label: a.label, createdAt: a.createdAt })),
            latest: latest ? { uri: latest.uri, text: readFileSync(latest.path, 'utf8').slice(-8000) } : null,
            latestBuildLogUri: latestBuildLog?.uri ?? null,
            latestStartLogUri: latestStartLog?.uri ?? null,
            latestErrorLogUri: latestErrorLog?.uri ?? null,
          },
          latest ? `latest WDA log: ${latest.uri}` : 'no WDA logs captured in this session',
        );
      }

      if (action === 'tune') {
        const recommendations = wdaRecommendations(configured, session);
        const timings = wdaTimingSummary(session);
        return qaOk(
          { webDriverAgentUrl: url, wdaConfig: effectiveConfig, timings, recommendations },
          recommendations.length
            ? `WDA tuning recommendations:\n${recommendations.map((r) => `  - ${r.setting}=${JSON.stringify(r.value)}: ${r.reason}`).join('\n')}`
            : 'WDA tuning: no recommendations from current session evidence.',
        );
      }

      if (action === 'stop') {
        const proc = managedProcesses.get(session.id);
        if (!proc) {
          // A WDA started by a previous server run and adopted at startup (processRegistry).
          // Matched by session, or by URL only together with this simulator's UDID.
          const adopted = adoptedWda(session.id, url, targetUdid);
          const outcome = adopted ? reclaimPid(adopted.pid, 'wda', undefined, adopted) : undefined; // fingerprint-checked
          if (adopted && (outcome === 'killed' || outcome === 'recycled' || !pidIsAlive(adopted.pid)))
            unregisterManagedProcess(adopted.pid);
          if (adopted && outcome === 'killed') {
            sessions.addEnvChange(session, `wda stop pid ${adopted.pid} (adopted)`);
            sessions.recordMutation(session, {
              tool: 'qa_wda',
              action: 'wda_stop',
              risk: 'low',
              target: { pid: adopted.pid, adopted: true, webDriverAgentUrl: adopted.endpoint ?? null },
              consent: { required: false, approved: true },
              status: 'restored',
              detail: `adopted WDA ${outcome}`,
            });
            return qaOk({ stopped: true, pid: adopted.pid, adopted: true, outcome }, `stopped adopted managed WDA pid ${adopted.pid}`);
          }
          // Registry entry lost (or unverifiable): find the managed xcodebuild this session started
          // by its exact signature (project + destination + derived data), never by pid alone.
          const sig = lastManagedWdaStart(session);
          const pids = sig ? findManagedWdaProcesses(sig) : [];
          const killed = pids.filter((pid) => killManagedWda(pid));
          if (!killed.length) {
            // This simulator's managed WDA recorded by another server run (adopted by a
            // live concurrent server, or not swept yet): any registry entry whose recorded
            // `-destination id=` is this UDID, fingerprint-checked before the signal.
            const forDevice = !adopted && targetUdid ? registeredWdasForDevice(targetUdid) : [];
            const outcomes = forDevice.map((e) => ({ e, outcome: reclaimPid(e.pid, 'wda', undefined, e) }));
            const deviceKilled = outcomes.filter((o) => o.outcome === 'killed').map((o) => o.e.pid);
            // Only rows whose process this call killed, or that is provably gone / no longer the
            // recorded WDA: a live WDA it failed to signal keeps its row, so its owning server (or a
            // later startup sweep) can still stop, reap or adopt it.
            for (const { e, outcome } of outcomes)
              if (outcome === 'killed' || outcome === 'recycled' || !pidIsAlive(e.pid)) unregisterManagedProcess(e.pid);
            if (deviceKilled.length) {
              const origin = wdaStopOrigin(outcomes.filter((o) => o.outcome === 'killed').map((o) => o.e));
              sessions.addEnvChange(session, `wda stop pid ${deviceKilled.join(',')} (registered for ${targetUdid})`);
              sessions.recordMutation(session, {
                tool: 'qa_wda',
                action: 'wda_stop',
                risk: 'low',
                target: { pids: deviceKilled, udid: targetUdid, webDriverAgentUrl: forDevice[0].endpoint ?? null },
                consent: { required: false, approved: true },
                status: 'restored',
                detail: `managed WDA for ${targetUdid} found in the process registry (${origin})`,
              });
              return qaOk(
                { stopped: true, pid: deviceKilled[0], pids: deviceKilled, udid: targetUdid },
                `stopped managed WDA pid ${deviceKilled.join(', ')} for simulator ${targetUdid} (${origin})`,
              );
            }
            if (adopted)
              return qaOk(
                { stopped: false, pid: adopted.pid, adopted: true, outcome },
                `adopted WDA pid ${adopted.pid} was already ${outcome}`,
              );
            return qaOk({ stopped: false }, 'no managed WDA process recorded for this session');
          }
          sessions.addEnvChange(session, `wda stop pid ${killed.join(',')} (recovered by signature)`);
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: 'wda_stop',
            risk: 'low',
            target: { pids: killed, recovered: true, projectPath: sig!.projectPath, udid: sig!.udid },
            consent: { required: false, approved: true },
            status: 'restored',
            detail: 'managed WDA located by command signature (registry entry missing)',
          });
          return qaOk(
            { stopped: true, pid: killed[0], pids: killed, recovered: true },
            `stopped managed WDA pid ${killed.join(', ')} (located by its xcodebuild signature; registry entry was missing)`,
          );
        }
        try {
          process.kill(proc.pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
        unregisterManagedProcess(proc.pid);
        managedProcesses.delete(session.id);
        sessions.addEnvChange(session, `wda stop pid ${proc.pid}`);
        sessions.recordMutation(session, {
          tool: 'qa_wda',
          action: 'wda_stop',
          risk: 'low',
          target: { pid: proc.pid, logUri: proc.logUri },
          consent: { required: false, approved: true },
          status: 'restored',
        });
        return qaOk({ stopped: true, pid: proc.pid, logUri: proc.logUri }, `stopped managed WDA pid ${proc.pid}`);
      }

      if (isWdaXcodebuildAction(action)) {
        if (!targetUdid) {
          return qaError({
            what: `qa_wda ${action} requires a simulator/device UDID`,
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Boot/select a simulator with qa_ios boot, or pass device explicitly.'],
          });
        }
        // W1: a previous build-for-testing left an .xctestrun under derivedDataPath, so
        // test-without-building can start WDA without building again.
        const xctestrun = rebuild ? undefined : findWdaXctestrun(ddPath, targetUdid, scheme);
        if (action === 'build' && xctestrun) {
          return qaOk(
            { built: true, reused: true, xctestrun, derivedDataPath: ddPath, wdaConfig: effectiveConfig },
            `WDA is already built (${xctestrun}); skipped build-for-testing (pass rebuild:true to force).\nNext: qa_wda start.`,
          );
        }
        // The URL this start/setup uses. WDA defaults to one port for every simulator, so a WDA
        // already on it may be ANOTHER simulator's: it is never reused, and a new one is never
        // started over it (the new runner would take the port from its owner). Instead this
        // simulator's WDA runs on its own loopback port (stable per UDID, else the next free one).
        let startUrl = url;
        let relocated: { from: string; reason: string } | undefined;
        if (action === 'start' || action === 'setup') {
          const reuseStartedAt = Date.now();
          let existing = await checkWda(url);
          let owner = existing.reachable ? await wdaDeviceOwnership(url, existing, targetUdid) : undefined;
          // unverified: a local listener lsof / ps could not inspect (loaded host). It may be another
          // simulator's WDA on the same runtime, so it is treated like one (never reused).
          const notOurs = owner?.owner === 'other' || owner?.owner === 'unverified';
          if (notOurs && webDriverAgentUrl) {
            return qaError(
              {
                what: `Refused to reuse or replace the WDA at ${url}: ${owner!.reason}`,
                changedState: false,
                retrySafe: owner!.owner === 'unverified',
                failureCode: 'STALE_WDA_DEVICE',
                nextSteps: [
                  `Omit webDriverAgentUrl so qa_wda ${action} starts this simulator's WDA on its own free port, or pass a URL whose port is free.`,
                ],
              },
              { webDriverAgentUrl: url, udid: targetUdid, wdaDevice: owner!.deviceUdid ?? null },
            );
          }
          // A managed WDA runs on this simulator's own port, not WDA's shared default 8100: two
          // setups started seconds apart both saw 8100 free and raced for it, and the loser reported
          // the winner's WDA as ready. The shared port is still reused when the WDA there
          // runs in this simulator (or is ready and is provably not a simulator process, e.g. an
          // external one).
          const sharedDefault = sessionUrl?.source === 'config' && wdaUrlPort(url) === 8100 && isSimulatorUdid(targetUdid);
          const usableHere = owner?.owner === 'match' || (owner?.owner === 'unknown' && configured.reuse && existing.ready);
          // A custom ios.wda.url port has the same start race: another simulator's managed WDA that
          // is still starting there (registered, not bound yet) means this one moves to its own port.
          const configPortReserved =
            sessionUrl?.source === 'config' &&
            isLoopback(url) &&
            !existing.reachable &&
            isSimulatorUdid(targetUdid) &&
            reservedWdaPorts(targetUdid).includes(wdaUrlPort(url) ?? -1);
          if (notOurs || configPortReserved || (sharedDefault && isLoopback(url) && !usableHere)) {
            if (notOurs) relocated = { from: url, reason: owner!.reason };
            else if (configPortReserved) relocated = { from: url, reason: `another simulator's managed WDA is starting on ${url}` };
            const own = await findOwnSimulatorWda(url, targetUdid);
            if (own) {
              startUrl = own.url;
              existing = own.status;
              owner = own.owner;
            } else {
              // Ports of other simulators' managed WDAs that are still starting (not bound yet) count as taken.
              const port = await freeWdaPort(targetUdid, [wdaUrlPort(url) ?? 0, ...reservedWdaPorts(targetUdid)]);
              if (!port)
                return qaError({
                  what: `No free loopback port was found for this simulator's WDA${notOurs ? ` (the WDA at ${url} is not usable for it: ${owner!.reason})` : ''}`,
                  changedState: false,
                  retrySafe: true,
                  failureCode: 'WDA_PORT_CONFLICT',
                  nextSteps: ['Free a port in 8101-8900, or pass webDriverAgentUrl with a free loopback port.'],
                });
              startUrl = wdaUrlWithPort(url, port);
              existing = { reachable: false, ready: false };
              owner = undefined;
            }
          }
          const reuseCheckMs = Date.now() - reuseStartedAt;
          sessions.addMilestoneDuration(session, 'wda_reuse_check_ms', reuseCheckMs);
          if (configured.reuse && existing.reachable && existing.ready) {
            // Recorded so attach / qa_wait (wdaUrlForSession) default to this URL.
            sessions.recordMutation(session, {
              tool: 'qa_wda',
              action: 'wda_reuse',
              risk: 'low',
              target: { udid: targetUdid, webDriverAgentUrl: startUrl, wdaDevice: owner?.deviceUdid ?? null },
              consent: { required: false, approved: true },
              status: 'executed',
              detail: owner?.reason,
            });
            return qaOk(
              {
                started: false,
                reused: true,
                ready: true,
                webDriverAgentUrl: startUrl,
                udid: targetUdid,
                deviceCheck: owner?.owner ?? 'unknown',
                ...(relocated ? { relocatedFrom: relocated.from } : {}),
                reuseCheckMs,
              },
              `reused existing WDA at ${startUrl}; /status is ready (${owner?.owner === 'match' ? `runs in simulator ${targetUdid}` : 'its device could not be verified'})` +
                `${relocated ? `\nNot ${relocated.from}: ${relocated.reason}.` : ''}\nNext: qa_wda attach.`,
            );
          }
        }
        // Never start a second managed xcodebuild over a live one: the new runner would fight it
        // for the port and the old one would be orphaned (managedProcesses would be overwritten).
        const running = action !== 'build' ? liveManagedWda(session.id, startUrl, targetUdid) : undefined;
        // A live xcodebuild whose runner died is replaced (stopped once the consent below is given).
        const staleRunning = running && (await managedWdaIsStale(running, configured.startupTimeoutMs)) ? running : undefined;
        if (running && !staleRunning) {
          return qaError(
            {
              what: `A managed WDA (pid ${running.pid}${running.adopted ? ', adopted from a previous server run' : ''}) is already running for this session`,
              changedState: false,
              retrySafe: true,
              failureCode: 'WDA_START_FAILED',
              nextSteps: ['Use it (qa_wda attach), or stop it first with qa_wda { action:"stop" } and retry start.'],
            },
            { managedPid: running.pid, adopted: running.adopted, webDriverAgentUrl: running.url ?? startUrl },
          );
        }
        const xcode = await xcodeAvailable();
        if (!xcode.available) {
          return qaError(
            {
              what: 'Xcode command line tools are unavailable',
              changedState: false,
              retrySafe: true,
              failureCode: 'BACKEND_UNSUPPORTED',
              nextSteps: [xcode.error ?? 'Install Xcode and select it with xcode-select.'],
            },
            { xcode },
          );
        }
        if (!projectPath || !existsSync(projectPath)) {
          return qaError(
            {
              what: `qa_wda ${action} requires wdaProjectPath pointing to WebDriverAgent.xcodeproj`,
              changedState: false,
              retrySafe: true,
              failureCode: 'NO_ARTIFACT',
              nextSteps: [
                "Pass wdaProjectPath, for example path/to/WebDriverAgent.xcodeproj, or install Appium's WebDriverAgent (appium driver install xcuitest) so it is auto-discovered under ~/.appium.",
              ],
            },
            { xcode, wdaProjectPath: projectPath ?? null, wdaProjectSource },
          );
        }
        const buildArgs = managedWdaBuildArgs({
          projectPath,
          udid: targetUdid,
          derivedDataPath: ddPath,
          scheme,
          developmentTeam: configured.developmentTeam,
        });
        const startArgs = managedWdaStartArgs({
          projectPath,
          udid: targetUdid,
          derivedDataPath: ddPath,
          scheme,
          developmentTeam: configured.developmentTeam,
        });
        const args = action === 'build' ? buildArgs : startArgs;
        const setupBuilds = action === 'setup' && !xctestrun;
        // setup asks ONE consent: wda_build when it has to build (the build and the start that
        // follows), else wda_start. A build+start runs unprompted only when SWIPIUM_CONSENT_PREAPPROVE
        // covers both: with wda_build alone pre-approved it asks under wda_start instead.
        const setupBuildAction = isOperatorPreapproved('wda_build') && !isOperatorPreapproved('wda_start') ? 'wda_start' : 'wda_build';
        const consentAction = action === 'setup' ? (setupBuilds ? setupBuildAction : 'wda_start') : `wda_${action}`;
        // The runner listens on startUrl's port, loopback only (managedWdaEnv).
        const startEnvPrefix = Object.entries(managedWdaEnv(startUrl, {}))
          .filter(([k]) => k.startsWith('TEST_RUNNER_'))
          .map(([k, v]) => `${k}=${v} `)
          .join('');
        const exactCommand = setupBuilds
          ? `xcodebuild ${buildArgs.join(' ')} && ${startEnvPrefix}xcodebuild ${startArgs.join(' ')}`
          : `${action === 'build' ? '' : startEnvPrefix}xcodebuild ${args.join(' ')}`;
        const gate = consumeConsent(consentId, approve, { action: consentAction, affects: { udid: targetUdid, projectPath } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: consentAction,
            risk: 'medium',
            target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: consentAction,
            risk: 'medium',
            exactCommand,
            affects: { udid: targetUdid, projectPath },
            explain:
              action === 'setup'
                ? `Set up WebDriverAgent with xcodebuild: ${setupBuilds ? 'build it, then start it' : `start the existing build (${xctestrun})`}? This can use local signing context and run for a while.`
                : `${action === 'build' ? 'Build' : 'Start'} WebDriverAgent with xcodebuild? This can use local signing context and run for a while.`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_wda',
          action: consentAction,
          risk: 'medium',
          target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
        if (staleRunning) {
          stopStaleManagedWda(session.id, staleRunning);
          sessions.addEnvChange(session, `wda stop pid ${staleRunning.pid} (runner gone, replaced by a new start)`);
        }
        const startCtx: WdaStartContext = {
          projectPath,
          udid: targetUdid,
          derivedDataPath: ddPath,
          scheme,
          consentId,
          args: startArgs,
          url: startUrl,
        };
        if (action === 'setup') {
          const job = sessions.createJob(session, 'wda_setup');
          const setupCtx: WdaSetupContext = {
            start: startCtx,
            build: setupBuilds
              ? {
                  projectPath,
                  udid: targetUdid,
                  derivedDataPath: ddPath,
                  scheme,
                  consentId,
                  args: buildArgs,
                  xcode,
                  wdaProjectSource,
                  wdaConfig: { ...effectiveConfig, url: startUrl },
                }
              : undefined,
            startupTimeoutMs: configured.startupTimeoutMs,
          };
          void runWithSignal(sessions.abortSignal(session, job.jobId), () => runWdaSetupJob(sessions, session, job, setupCtx));
          return qaOk(
            {
              jobId: job.jobId,
              status: 'running',
              kind: job.kind,
              willBuild: setupBuilds,
              ...(xctestrun ? { xctestrun } : {}),
              wdaProjectPath: projectPath,
              wdaProjectSource,
              derivedDataPath: ddPath,
              webDriverAgentUrl: startUrl,
              ...(relocated ? { relocatedFrom: relocated.from } : {}),
            },
            `Started WDA setup (${setupBuilds ? 'build, then start' : 'start the existing build'}) as job ${job.jobId} on ${startUrl}.` +
              `${relocated ? `\nNot ${relocated.from}: ${relocated.reason}.` : ''}\nNext: qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}", waitMs:45000 } until done, then qa_wda attach.`,
          );
        }
        if (action === 'build') {
          // xcodebuild build-for-testing can take minutes: run it as a background job so this call
          // returns at once (one tool call stays under client timeouts). Consent was consumed above.
          const job = sessions.createJob(session, 'wda_build');
          const buildCtx: WdaBuildContext = {
            projectPath,
            udid: targetUdid,
            derivedDataPath: ddPath,
            scheme,
            consentId,
            args,
            xcode,
            wdaProjectSource,
            wdaConfig: { ...effectiveConfig, url: startUrl },
          };
          void runWithSignal(sessions.abortSignal(session, job.jobId), () => runWdaBuildJob(sessions, session, job, buildCtx));
          return qaOk(
            {
              jobId: job.jobId,
              status: 'running',
              kind: job.kind,
              command: ['xcodebuild', ...args],
              wdaProjectPath: projectPath,
              wdaProjectSource,
              derivedDataPath: ddPath,
            },
            `Started WDA build (${wdaProjectSource === 'appium-discovered' ? 'auto-discovered Appium WDA ' : ''}${projectPath}) as job ${job.jobId}.\nNext: qa_job_status { sessionId:"${session.id}", jobId:"${job.jobId}", waitMs:45000 }, then qa_wda start.`,
          );
        }
        const { child, logUri } = spawnManagedWda(sessions, session, startCtx);
        // Cancelled while waiting: WDA stays started (managed + registered, so the next attach can
        // adopt it); report CANCELLED, not a WDA startup failure.
        // Bounded in-call wait: at most WDA_START_CALL_WAIT_MS here; the rest of the configured
        // startupTimeoutMs is polled by the agent via qa_wait { for:"wda_ready" }.
        const callWaitMs = Math.min(configured.startupTimeoutMs, WDA_START_CALL_WAIT_MS);
        const waited = await waitForWdaReady(startUrl, callWaitMs).catch((e: unknown) => {
          if (isAbortError(e)) return null;
          throw e;
        });
        if (!waited) return cancelledResult('qa_wda start cancelled while waiting for WDA; the managed WDA process was left running', true);
        sessions.addMilestoneDuration(session, 'wda_startup_wait_ms', waited.durationMs);
        const lostPort = waited.ready ? await startLostPort(session, startCtx, child.pid ?? -1, waited.status) : undefined;
        if (lostPort) {
          return qaError(
            {
              what: `Managed WDA did not start: ${lostPort}`,
              changedState: false,
              retrySafe: true,
              failureCode: 'WDA_PORT_CONFLICT',
              artifactUri: logUri,
              nextSteps: [`Retry qa_wda { action:"${action}" }: it picks a free port for ${targetUdid}.`],
            },
            { started: false, ready: false, webDriverAgentUrl: startUrl, logUri },
          );
        }
        const remainingMs = configured.startupTimeoutMs - waited.durationMs;
        if (!waited.ready && remainingMs > 0 && pidIsAlive(child.pid ?? -1)) {
          return qaOk(
            {
              started: true,
              ready: false,
              status: 'starting',
              pid: child.pid ?? null,
              logUri,
              webDriverAgentUrl: startUrl,
              wdaProjectPath: projectPath,
              wdaProjectSource,
              command: ['xcodebuild', ...args],
              startupWaitMs: waited.durationMs,
              startupTimeoutMs: configured.startupTimeoutMs,
              remainingStartupMs: remainingMs,
            },
            `started managed WDA pid ${child.pid ?? 'unknown'}; /status not ready yet after ${Math.round(waited.durationMs / 1000)} s (still starting) > ${logUri}
` +
              `Next: qa_wait { sessionId:"${session.id}", for:"wda_ready" } (repeat while timedOut, up to ~${Math.ceil(remainingMs / 1000)} s more), then qa_wda attach.`,
          );
        }
        if (!waited.ready) {
          const exited = remainingMs > 0; // only reached early when the xcodebuild process is gone
          const why = `WDA not ready after ${waited.durationMs}ms${exited ? ' (the managed xcodebuild process exited)' : ''}`;
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: 'wda_start',
            risk: 'medium',
            target: {
              udid: targetUdid,
              projectPath,
              derivedDataPath: ddPath,
              scheme: scheme ?? null,
              pid: child.pid ?? null,
              webDriverAgentUrl: startUrl,
            },
            consent: { required: true, consentId, approved: true },
            status: 'blocked',
            ledgerUri: logUri,
            detail: why,
          });
          return qaError(
            {
              what: exited
                ? `Managed WDA exited before becoming ready at ${startUrl} (waited ${waited.durationMs}ms)`
                : `Managed WDA did not become ready at ${startUrl} within ${configured.startupTimeoutMs}ms`,
              changedState: true,
              retrySafe: true,
              failureCode: 'WDA_START_FAILED',
              artifactUri: logUri,
              nextSteps: [
                'Open the WDA start log artifact, fix the launch/signing/device issue, then retry qa_wda start. If WDA eventually becomes ready, qa_wda attach can still use this managed process.',
              ],
            },
            {
              started: true,
              ready: false,
              pid: child.pid ?? null,
              logUri,
              webDriverAgentUrl: startUrl,
              command: ['xcodebuild', ...args],
              wdaConfig: { ...effectiveConfig, url: startUrl },
              wda: waited.status,
              startupWaitMs: waited.durationMs,
            },
          );
        }
        return qaOk(
          {
            started: true,
            ready: true,
            pid: child.pid ?? null,
            logUri,
            webDriverAgentUrl: startUrl,
            wdaProjectPath: projectPath,
            wdaProjectSource,
            command: ['xcodebuild', ...args],
            startupWaitMs: waited.durationMs,
          },
          `started managed WDA pid ${child.pid ?? 'unknown'} on ${startUrl}; /status is ready > ${logUri}${relocated ? `\nNot ${relocated.from}: ${relocated.reason}.` : ''}\nNext: qa_wda attach.`,
        );
      }

      let status = await checkWda(url);
      // A session with no WDA of its own yet defaults to the configured URL (shared 8100). When the
      // WDA there is not provably this simulator's (down, slow, unidentifiable, another one's), use
      // this simulator's own managed WDA on its per-simulator / registered port if one runs.
      if (!webDriverAgentUrl && sessionUrl?.source === 'config' && targetUdid && isSimulatorUdid(targetUdid) && loopback) {
        const here = status.reachable ? await wdaDeviceOwnership(url, status, targetUdid) : undefined;
        if (here?.owner !== 'match') {
          const own = await findOwnSimulatorWda(url, targetUdid);
          if (own) {
            url = own.url;
            status = own.status;
          }
        }
      }
      if (action === 'attach') {
        // attach: lean replies (details: action:"status"); none of the diagnostics below run first.
        const appId = bundleId ?? session.appId ?? null;
        const base = {
          webDriverAgentUrl: url,
          udid: targetUdid ?? null,
          bundleId: appId,
          wda: { reachable: status.reachable, ready: status.ready },
        };
        if (!targetUdid) {
          return qaError(
            {
              what: 'Refused ambiguous WDA attach without a simulator/device UDID',
              changedState: false,
              retrySafe: true,
              failureCode: 'MULTIPLE_DEVICES',
              nextSteps: [
                'Pass device explicitly, or bind the session to a device first. This prevents attaching to a stale WDA for the wrong device.',
              ],
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
              nextSteps: [
                'Start it with qa_wda { action:"setup" } (or start an external WDA and confirm /status responds), then retry qa_wda attach.',
              ],
            },
            base,
          );
        }
        // Never create a session on another simulator's WDA (shared default port): session creation
        // would launch the app there and tear down its owner's WDA session.
        const owner = await wdaDeviceOwnership(url, status, targetUdid);
        // An uninspectable listener (lsof / ps timed out) may be another simulator's WDA on the same
        // runtime: refused too, unless it is the WDA this session itself started / reused / attached.
        const ownUrl = !webDriverAgentUrl && sessionUrl?.source !== 'config' && url === sessionUrl?.url;
        if (owner.owner === 'other' || (owner.owner === 'unverified' && !ownUrl)) {
          return qaError(
            {
              what: `Refused to attach: ${owner.reason}`,
              changedState: false,
              retrySafe: owner.owner === 'unverified',
              failureCode: 'STALE_WDA_DEVICE',
              nextSteps: [
                `Run qa_wda { action:"setup" } to start a WDA for ${targetUdid} on its own port, then qa_wda attach (it defaults to that WDA).`,
              ],
            },
            { ...base, wdaDevice: owner.deviceUdid ?? null },
          );
        }
        try {
          const sessionOptions = {
            bundleId: appId ?? undefined,
            udid: targetUdid,
            capabilities: configured.capabilities,
            settings: configured.settings,
          };
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
              tool: 'qa_wda',
              action: 'wda_attach',
              risk: 'medium',
              target: { webDriverAgentUrl: url, udid: targetUdid, bundleId: appId ?? null, reportedDevice: mismatchedUdid },
              consent: { required: !loopback && !userAllowed, consentId, approved: loopback || userAllowed || !!approve },
              status: 'blocked',
              detail: 'WDA reported a different device',
            });
            return qaError(
              {
                what: `Refused stale WDA session: WDA reported device ${mismatchedUdid}, but this session requested ${targetUdid}`,
                changedState: false,
                retrySafe: false,
                failureCode: 'STALE_WDA_DEVICE',
                nextSteps: ['Stop the stale WDA process or start a new WDA session for the intended UDID.'],
              },
              { ...base, capabilities: created.capabilities ?? null, wdaSessionId: created.sessionId },
            );
          }
          const driver = new WdaDriver(url, {
            ...sessionOptions,
            sessionId: created.sessionId,
            onTiming: (kind, ms) => recordWdaTiming(session, kind, ms, sessions),
          });
          session.driver = driver;
          session.device = targetUdid;
          if (appId) session.appId = appId;
          sessions.persist(session);
          sessions.addEnvChange(session, `wda attach ${url}${udid ? ` ${udid}` : ''}`);
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: 'wda_attach',
            risk: 'medium',
            target: {
              webDriverAgentUrl: url,
              udid: targetUdid,
              bundleId: appId ?? null,
              wdaSessionId: created.sessionId,
              capabilities: created.capabilities ?? null,
            },
            consent: { required: !loopback && !userAllowed, consentId, approved: true },
            status: 'executed',
          });
          return qaOk(
            {
              webDriverAgentUrl: url,
              udid: targetUdid,
              bundleId: appId,
              driverKind: driver.kind,
              sessionActive: true,
              wdaSessionId: created.sessionId,
              deviceCheck: owner.owner,
            },
            `attached WDA structured iOS backend at ${url} (${targetUdid})\nNext: qa_snapshot / qa_act / qa_flow_run can use WDA-backed structured operations.`,
          );
        } catch (e) {
          const failureCode = classifyWdaConnectionFailure(String((e as Error).message ?? e));
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: 'wda_attach',
            risk: 'medium',
            target: { webDriverAgentUrl: url, udid: targetUdid, bundleId: appId ?? null },
            consent: { required: !loopback && !userAllowed, consentId, approved: loopback || userAllowed || !!approve },
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

      const xcode = await xcodeAvailable();
      const bootedUdid = session.device ?? udid ?? null;
      const appId = bundleId ?? session.appId ?? null;
      const artifactSummary = latestWdaArtifacts(session);
      // Same discovery setup/build/start act on (project-local + the user's Appium WDA).
      const wdaProjectDiscovery = discoverWdaProjectsWithAppium(session.root, projectPath ? [projectPath] : []);
      // A ready WDA on the shared default port may belong to another simulator.
      const deviceCheck =
        status.reachable && bootedUdid && isSimulatorUdid(bootedUdid) ? await wdaDeviceOwnership(url, status, bootedUdid) : undefined;
      // Reported whenever managed WDA is in play OR a derived-data cache exists (e.g. after a
      // qa_wda build that used an auto-discovered Appium project and no explicit path).
      const wdaBuildProduct =
        configured.mode === 'managed' || !!projectPath || existsSync(ddPath) ? managedWdaBuildProductStatus(ddPath) : null;
      const simctlOk = await sim.simctlAvailable().catch(() => false);
      const simulators = simctlOk ? await sim.listSimulators().catch(() => []) : [];
      const bootedSimulators = simulators.filter((s) => s.state === 'Booted');
      let appInstalled: boolean | null = null;
      if (bootedUdid && appId && simctlOk) {
        appInstalled = await sim.isInstalled(bootedUdid, appId).catch(() => null);
      }
      const base = {
        hostPlatform: process.platform,
        xcode,
        simulatorUdid: bootedUdid,
        bundleId: appId,
        webDriverAgentUrl: url,
        wda: status,
        wdaDevice: deviceCheck ? { check: deviceCheck.owner, udid: deviceCheck.deviceUdid ?? null, reason: deviceCheck.reason } : null,
        wdaConfig: effectiveConfig,
        wdaProjectDiscovery,
        signing: wdaSigningStatus(configured),
        wdaBuildProduct,
        sessionActive: session.driver instanceof WdaDriver,
        driverKind: session.driver?.kind ?? null,
        appInstalled,
        simctlAvailable: simctlOk,
        bootedSimulators: bootedSimulators.map((s) => ({ udid: s.udid, name: s.name, runtime: s.runtime })),
        managedProcess: managedProcessSummary(session.id),
        latestLogUri: artifactSummary.latestLog?.uri ?? null,
        latestBuildLogUri: artifactSummary.latestBuildLog?.uri ?? null,
        latestStartLogUri: artifactSummary.latestStartLog?.uri ?? null,
        latestErrorLogUri: artifactSummary.latestErrorLog?.uri ?? null,
        tuning: { timings: wdaTimingSummary(session), recommendations: wdaRecommendations(configured, session) },
      };

      // status / doctor / diagnose (every other action returned above).
      {
        const issues: WdaDiagnosticIssue[] = [];
        const wantsManaged = configured.mode === 'managed' || !!projectPath;
        if (wantsManaged && process.platform !== 'darwin')
          issues.push(
            issue('HOST_UNSUPPORTED', 'managed WDA requires a macOS host', 'Run managed WDA on macOS, or provide an external WDA URL.'),
          );
        if (wantsManaged && !xcode.available)
          issues.push(
            issue(
              'XCODE_UNAVAILABLE',
              'xcodebuild is unavailable',
              xcode.error ?? 'Install Xcode command line tools and select them with xcode-select.',
            ),
          );
        if (process.platform === 'darwin' && !simctlOk)
          issues.push(
            issue(
              'SIMCTL_UNAVAILABLE',
              'xcrun simctl is unavailable',
              'Install/select Xcode command line tools, then retry qa_ios list or qa_wda doctor.',
            ),
          );
        if (!bootedUdid && simctlOk && simulators.length === 0) {
          issues.push(
            issue(
              'IOS_SIMULATOR_RUNTIME_MISSING',
              'xcrun simctl is available, but no iOS simulators were found',
              'Install an iOS simulator runtime in Xcode, create an iPhone simulator, then retry qa_wda doctor.',
              'blocker',
              'SIMULATOR_RUNTIME_MISSING',
            ),
          );
        } else if (!bootedUdid && simctlOk && bootedSimulators.length === 0) {
          issues.push(
            issue(
              'NO_BOOTED_SIMULATOR',
              'no booted iOS simulator was detected',
              'Boot/select a simulator with qa_ios boot, or pass device for an already-running WDA target.',
            ),
          );
        }
        if (!bootedUdid)
          issues.push(
            issue(
              'NO_UDID',
              'no simulator/device UDID is bound to this session',
              'Boot/select a simulator with qa_ios boot, or pass device explicitly.',
            ),
          );
        // No path given but a user-installed Appium WDA exists: build/start will auto-use it.
        const appiumAuto = wantsManaged && !projectPath ? discoverAppiumWdaProjects()[0] : undefined;
        if (wantsManaged && (!projectPath || !existsSync(projectPath)) && !appiumAuto) {
          const discovered = wdaProjectDiscovery.candidates[0];
          issues.push(
            issue(
              'WDA_PROJECT_MISSING',
              discovered
                ? `managed WDA needs wdaProjectPath; discovered candidate ${discovered}`
                : 'managed WDA needs a WebDriverAgent.xcodeproj path; no local candidate was discovered',
              discovered
                ? `Pass wdaProjectPath: "${discovered}", or configure ios.wda for that checked-out WebDriverAgent project.`
                : 'Check out WebDriverAgent/Appium WDA, pass wdaProjectPath, or provide an external WDA URL.',
            ),
          );
        }
        if (wantsManaged && projectPath && existsSync(projectPath) && wdaBuildProduct && !wdaBuildProduct.built)
          issues.push(
            issue(
              'WDA_NOT_BUILT',
              `no WebDriverAgentRunner .app was found under derivedDataPath ${wdaBuildProduct.checkedPath}`,
              'Run qa_wda build first, or point ios.wda.derivedDataPath at a cache containing a built WebDriverAgentRunner product.',
            ),
          );
        if (wantsManaged && !configured.developmentTeam)
          issues.push(
            issue(
              'WDA_SIGNING_UNCONFIGURED',
              'no development team is configured for managed WDA signing',
              'Set ios.wda.developmentTeam in .swipium/config.json or DEVELOPMENT_TEAM/XCODE_DEVELOPMENT_TEAM in the environment.',
              'warn',
            ),
          );
        if (!status.reachable)
          issues.push(
            issue(
              'WDA_SERVER_UNAVAILABLE',
              `WDA server is unavailable at ${url}`,
              'Start WebDriverAgent externally, or run qa_wda build/start for managed WDA.',
            ),
          );
        else if (deviceCheck?.owner === 'other')
          issues.push(
            issue(
              'STALE_WDA_DEVICE',
              `the WDA at ${url} belongs to another device: ${deviceCheck.reason}`,
              'Run qa_wda { action:"setup" } to start a WDA for this simulator on its own port, then qa_wda attach.',
              'blocker',
              'STALE_WDA_DEVICE',
            ),
          );
        else if (!status.ready)
          issues.push(
            issue(
              'WDA_NOT_READY',
              status.message ?? `WDA responded at ${url} but did not report ready`,
              'Check WDA logs and wait/restart before attaching.',
              'warn',
            ),
          );
        if (!appId)
          issues.push(
            issue(
              'NO_BUNDLE_ID',
              'no app bundle id is configured for WDA session creation',
              'Set appId in .swipium/config.json, prepare the target, or pass bundleId.',
              // WDA itself is fine without one (sessions attach without an app): not a blocker, so a
              // ready WDA no longer reads "WDA status: blocked" (GOAL R3 note).
              'warn',
            ),
          );
        if (appInstalled === false)
          issues.push(
            issue(
              'APP_NOT_INSTALLED',
              `bundle id ${appId} is not installed on ${bootedUdid}`,
              'Install/launch the app with qa_ios or qa_prepare_target before attaching WDA.',
            ),
          );
        if (artifactSummary.latestErrorLog) {
          const failureCode = latestErrorFailure(artifactSummary.latestErrorLog.path);
          if (failureCode === 'WDA_SIGNING_FAILED') {
            issues.push(
              issue(
                'WDA_SIGNING_FAILED',
                `latest WDA build log indicates signing/provisioning failed: ${artifactSummary.latestErrorLog.uri}`,
                'Configure WDA signing/provisioning for the target device, then rerun qa_wda build.',
                'blocker',
                failureCode,
              ),
            );
          } else if (failureCode === 'WDA_BUILD_FAILED') {
            issues.push(
              issue(
                'WDA_BUILD_FAILED',
                `latest WDA build log indicates xcodebuild failed: ${artifactSummary.latestErrorLog.uri}`,
                'Open the WDA build log artifact, fix the Xcode build error, then rerun qa_wda build.',
                'blocker',
                failureCode,
              ),
            );
          }
          issues.push(
            issue(
              'LAST_WDA_ERROR_LOG',
              `latest WDA error log artifact: ${artifactSummary.latestErrorLog.uri}${failureCode ? ` (${failureCode})` : ''}`,
              'Open qa_wda logs or qa_get_artifact for the captured WDA failure log.',
              'warn',
              failureCode,
            ),
          );
        }
        const blockers = issues.filter((i) => i.severity === 'blocker');
        const nextSteps = issues.map((i) => i.nextStep);
        const summary = issues.length
          ? `WDA ${action}: ${blockers.length ? 'blocked' : 'warning'}\n` + issues.map((i) => `  - ${i.code}: ${i.detail}`).join('\n')
          : `WDA ${action}: ready at ${url}`;
        return qaOk({ ...base, issues, nextSteps, ready: blockers.length === 0 }, summary);
      }
    },
  );
}

interface WdaStartContext {
  projectPath: string;
  udid: string;
  derivedDataPath: string;
  scheme?: string;
  consentId?: string;
  args: string[];
  url: string;
  /** Set when the setup job moved the runner to another port after the consent was given (the
   *  approved exactCommand named `url` before the move): recorded in the ledger and the job result. */
  portMovedFrom?: string;
}

/** Spawn the managed `xcodebuild test-without-building` (detached, logged, registered so the next
 *  server can adopt or reap it) and record the executed wda_start mutation. Shared by start/setup. */
function spawnManagedWda(sessions: SessionStore, session: Session, ctx: WdaStartContext): { child: ChildProcess; logUri: string } {
  const logUri = sessions.saveArtifact(session, 'wda', `wda-start-${Date.now()}.log`, '', 'text/plain', 'WDA start log');
  const rec = sessions.findArtifact(logUri)!;
  const fd = openSync(rec.rec.path, 'a');
  sessions.milestone(session, 'wda_start_start');
  let child: ChildProcess;
  try {
    // USE_PORT / USE_IP: listen on ctx.url's port (per-simulator), on loopback only.
    child = spawn('xcodebuild', ctx.args, { detached: true, stdio: ['ignore', fd, fd], env: managedWdaEnv(ctx.url) });
  } finally {
    closeSync(fd); // the child holds its own duplicate; ours would leak one fd per start
  }
  sessions.milestone(session, 'wda_start_end');
  child.on('error', () => undefined); // spawn failure surfaces as WDA_START_FAILED, not a crash
  child.unref();
  managedProcesses.set(session.id, { pid: child.pid ?? -1, logUri, logPath: rec.rec.path, url: ctx.url, startedAt: Date.now() });
  // Reapable if this server crashes; `endpoint` lets the next server adopt it when healthy.
  registerManagedProcess(child.pid, 'wda', session.id, { endpoint: ctx.url });
  sessions.addEnvChange(session, `wda start pid ${child.pid ?? 'unknown'} ${ctx.projectPath} ${ctx.udid}`);
  sessions.recordMutation(session, {
    tool: 'qa_wda',
    action: 'wda_start',
    risk: 'medium',
    target: {
      udid: ctx.udid,
      projectPath: ctx.projectPath,
      derivedDataPath: ctx.derivedDataPath,
      scheme: ctx.scheme ?? null,
      pid: child.pid ?? null,
      webDriverAgentUrl: ctx.url,
    },
    consent: { required: true, consentId: ctx.consentId, approved: true },
    status: 'executed',
    ledgerUri: logUri,
    detail: ctx.portMovedFrom
      ? `managed WDA process started; port changed from ${ctx.portMovedFrom} to ${ctx.url} after consent (the approved one was taken)`
      : 'managed WDA process started',
  });
  return { child, logUri };
}

/** /status on the start URL can answer from ANOTHER simulator's WDA that bound the port
 *  first (this runner then fails with "Address already in use"), so a ready answer only counts
 *  when the listener is not provably another device's. When it is, this start's xcodebuild is
 *  stopped and forgotten, and the reason is returned. */
async function startLostPort(session: Session, ctx: WdaStartContext, pid: number, status: WdaStatus): Promise<string | undefined> {
  const owner = await wdaDeviceOwnership(ctx.url, status, ctx.udid);
  if (owner.owner !== 'other') return undefined;
  if (pidIsAlive(pid)) killManagedWda(pid);
  unregisterManagedProcess(pid);
  if (managedProcesses.get(session.id)?.pid === pid) managedProcesses.delete(session.id);
  return `${owner.reason}: another simulator's WDA took port ${wdaUrlPort(ctx.url) ?? '?'} first, so this simulator's WDA could not listen there`;
}

interface WdaBuildContext {
  projectPath: string;
  udid: string;
  derivedDataPath: string;
  scheme?: string;
  consentId?: string;
  args: string[];
  xcode: Awaited<ReturnType<typeof xcodeAvailable>>;
  wdaProjectSource: string | null;
  wdaConfig: Record<string, unknown>;
}

/** Background body of `qa_wda build` (runs inside the job's cancellation scope). The job ends
 *  done (built) or failed (classified build failure); a cancelled job is left cancelled. Exported
 *  for tests. */
export async function runWdaBuildJob(sessions: SessionStore, session: Session, job: JobRecord, ctx: WdaBuildContext): Promise<void> {
  const built = await runWdaBuild(sessions, session, job, ctx);
  if (!built) return;
  sessions.updateJobIfRunning(session, job, {
    status: 'done',
    progress: 'done',
    artifactUris: [built.logUri],
    result: {
      built: true,
      logUri: built.logUri,
      xcode: ctx.xcode,
      command: ['xcodebuild', ...ctx.args],
      wdaConfig: ctx.wdaConfig,
      wdaProjectPath: ctx.projectPath,
      wdaProjectSource: ctx.wdaProjectSource,
      derivedDataPath: ctx.derivedDataPath,
      wdaBuildProduct: built.wdaBuildProduct,
    },
    resultText: `WDA build completed (${ctx.wdaProjectSource === 'appium-discovered' ? 'auto-discovered Appium WDA ' : ''}${ctx.projectPath}) > ${built.logUri}\nNext: qa_wda start.`,
    endedAt: Date.now(),
  });
}

/** xcodebuild build-for-testing inside a job. Returns the log on success; on failure the job is
 *  already failed (classified) and on cancel left cancelled, and it returns undefined. */
async function runWdaBuild(
  sessions: SessionStore,
  session: Session,
  job: JobRecord,
  ctx: WdaBuildContext,
): Promise<{ logUri: string; wdaBuildProduct: ReturnType<typeof managedWdaBuildProductStatus> } | undefined> {
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const target = { udid: ctx.udid, projectPath: ctx.projectPath, derivedDataPath: ctx.derivedDataPath, scheme: ctx.scheme ?? null };
  const consent = { required: true, consentId: ctx.consentId, approved: true };
  upd({ progress: 'xcodebuild build-for-testing' });
  // The default derived-data cache (~200 MB) lives under <project>/.swipium: keep it out of VCS.
  if (ctx.derivedDataPath.startsWith(join(session.root, '.swipium'))) ensureGitignored(session.root);
  sessions.milestone(session, 'wda_build_start');
  let r: Awaited<ReturnType<typeof run>>;
  try {
    r = await run('xcodebuild', ctx.args, { timeoutMs: WDA_BUILD_TIMEOUT_MS, signal });
  } catch (e) {
    if (isAbortError(e, signal)) return; // cancelled (qa_job_cancel / shutdown): the job already says so
    const what = `xcodebuild could not run: ${String((e as Error).message ?? e)}`;
    sessions.recordMutation(session, {
      tool: 'qa_wda',
      action: 'wda_build',
      risk: 'medium',
      target,
      consent,
      status: 'blocked',
      detail: what,
    });
    upd({
      status: 'failed',
      error: `WDA_BUILD_FAILED: ${what}`,
      result: { failureCode: 'WDA_BUILD_FAILED', nextSteps: ['Check the Xcode installation (qa_wda doctor), then retry qa_wda build.'] },
      resultText: `WDA build could not start: ${what}`,
      endedAt: Date.now(),
    });
    return undefined;
  }
  sessions.milestone(session, 'wda_build_end');
  if (signal?.aborted) return undefined;
  const log = `${r.stdout}\n${r.stderr}`;
  const logUri = sessions.saveArtifact(
    session,
    'wda',
    `wda-build-${Date.now()}.log`,
    log,
    'text/plain',
    `WDA build ${r.code === 0 ? 'success' : 'failed'}`,
  );
  sessions.addEnvChange(session, `wda build ${ctx.projectPath} ${ctx.udid}`);
  if (r.code !== 0) {
    const failureCode = classifyWdaBuildFailure(log);
    sessions.recordMutation(session, {
      tool: 'qa_wda',
      action: 'wda_build',
      risk: 'medium',
      target,
      consent,
      status: 'blocked',
      ledgerUri: logUri,
      detail: `${failureCode}: exit ${r.code}`,
    });
    const signing = failureCode === 'WDA_SIGNING_FAILED';
    const what = signing
      ? `WDA signing/provisioning failed with exit ${r.code}`
      : `WDA build failed with exit ${r.code}${r.timedOut ? ` (timed out after ${WDA_BUILD_TIMEOUT_MS} ms)` : ''}`;
    upd({
      status: 'failed',
      error: `${failureCode}: ${what}`,
      artifactUris: [logUri],
      result: {
        failureCode,
        logUri,
        timedOut: r.timedOut,
        retrySafe: !signing,
        nextSteps: signing
          ? [
              'Open the WDA build log artifact, configure a valid development team/certificate/provisioning profile for the device, then retry.',
            ]
          : ['Open the WDA build log artifact, fix the Xcode build error, then retry.'],
      },
      resultText: `${what}. Log: ${logUri}`,
      endedAt: Date.now(),
    });
    return undefined;
  }
  sessions.recordMutation(session, {
    tool: 'qa_wda',
    action: 'wda_build',
    risk: 'medium',
    target,
    consent,
    status: 'executed',
    ledgerUri: logUri,
  });
  return { logUri, wdaBuildProduct: managedWdaBuildProductStatus(ctx.derivedDataPath) };
}

interface WdaSetupContext {
  start: WdaStartContext;
  /** Present when no reusable build (.xctestrun) exists: build first. */
  build?: WdaBuildContext;
  startupTimeoutMs: number;
}

/** Background body of `qa_wda setup` (C4): build when needed, then start the managed WDA and wait
 *  for /status (bounded by ios.wda.startupTimeoutMs; a job, so no per-call limit). Exported for tests. */
export async function runWdaSetupJob(sessions: SessionStore, session: Session, job: JobRecord, ctx: WdaSetupContext): Promise<void> {
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  let buildLogUri: string | undefined;
  if (ctx.build) {
    const built = await runWdaBuild(sessions, session, job, ctx.build);
    if (!built) return;
    buildLogUri = built.logUri;
  }
  upd({ progress: 'xcodebuild test-without-building (waiting for WDA /status)' });
  // The port was picked before the (possibly minutes-long) build: another simulator's WDA may hold
  // it now. Pick a free one for this simulator instead of starting a runner that cannot bind.
  if (isLoopbackWdaUrl(ctx.start.url)) {
    const pre = await checkWda(ctx.start.url, 1500);
    const preOwner = pre.reachable ? (await wdaDeviceOwnership(ctx.start.url, pre, ctx.start.udid)).owner : undefined;
    if (preOwner === 'other' || preOwner === 'unverified') {
      const port = await freeWdaPort(ctx.start.udid, [wdaUrlPort(ctx.start.url) ?? 0, ...reservedWdaPorts(ctx.start.udid)]);
      if (port) {
        // The consent's exactCommand named the old port: say so in the ledger and the job result.
        ctx.start.portMovedFrom = ctx.start.url;
        ctx.start.url = wdaUrlWithPort(ctx.start.url, port);
      }
    }
  }
  const { child, logUri } = spawnManagedWda(sessions, session, ctx.start);
  const pid = child.pid ?? -1;
  const started = Date.now();
  let status: Awaited<ReturnType<typeof waitForWdaReady>>['status'] = { reachable: false, ready: false };
  let ready = false;
  try {
    // Poll in short slices so a runner that exits early fails the job at once.
    while (!ready && Date.now() - started < ctx.startupTimeoutMs && pidIsAlive(pid)) {
      const w = await waitForWdaReady(ctx.start.url, Math.min(5000, ctx.startupTimeoutMs - (Date.now() - started)));
      status = w.status;
      ready = w.ready;
    }
  } catch (e) {
    if (isAbortError(e)) return; // cancelled: WDA stays started (managed + registered), job says cancelled
    throw e;
  }
  const waitedMs = Date.now() - started;
  sessions.addMilestoneDuration(session, 'wda_startup_wait_ms', waitedMs);
  const artifactUris = [...(buildLogUri ? [buildLogUri] : []), logUri];
  const lostPort = ready ? await startLostPort(session, ctx.start, pid, status) : undefined;
  if (lostPort) {
    upd({
      status: 'failed',
      error: `WDA_PORT_CONFLICT: ${lostPort}`,
      artifactUris,
      result: {
        built: !!ctx.build,
        ready: false,
        webDriverAgentUrl: ctx.start.url,
        logUri,
        failureCode: 'WDA_PORT_CONFLICT',
        nextSteps: [
          `Retry qa_wda { action:"setup", device:"${ctx.start.udid}" } without webDriverAgentUrl: it picks a free port for this simulator.`,
        ],
      },
      resultText: `WDA setup failed: ${lostPort}. Log: ${logUri}\nNext: retry qa_wda setup (it picks a free port).`,
      endedAt: Date.now(),
    });
    return;
  }
  const base = {
    built: !!ctx.build,
    pid: child.pid ?? null,
    logUri,
    ...(buildLogUri ? { buildLogUri } : {}),
    webDriverAgentUrl: ctx.start.url,
    ...(ctx.start.portMovedFrom ? { portMovedFrom: ctx.start.portMovedFrom } : {}),
    udid: ctx.start.udid,
    wdaProjectPath: ctx.start.projectPath,
    command: ['xcodebuild', ...ctx.start.args],
    wda: status,
    startupWaitMs: waitedMs,
  };
  if (!ready) {
    const exited = !pidIsAlive(pid);
    const what = exited
      ? `Managed WDA exited before becoming ready at ${ctx.start.url} (waited ${waitedMs}ms)`
      : `Managed WDA did not become ready at ${ctx.start.url} within ${ctx.startupTimeoutMs}ms`;
    upd({
      status: 'failed',
      error: `WDA_START_FAILED: ${what}`,
      artifactUris,
      result: {
        ...base,
        ready: false,
        failureCode: 'WDA_START_FAILED',
        nextSteps: [
          'Open the WDA start log artifact, fix the launch/signing/device issue, then retry qa_wda setup (rebuild:true forces a fresh build).',
        ],
      },
      resultText: `${what}. Log: ${logUri}`,
      endedAt: Date.now(),
    });
    return;
  }
  upd({
    status: 'done',
    progress: 'done',
    artifactUris,
    result: { ...base, ready: true },
    resultText:
      `WDA ${ctx.build ? 'built and ' : ''}started (pid ${child.pid ?? 'unknown'}); /status is ready at ${ctx.start.url} > ${logUri}` +
      `${ctx.start.portMovedFrom ? `\nPort changed from ${ctx.start.portMovedFrom} after consent: another WDA had taken it.` : ''}` +
      `\nNext: qa_wda { action:"attach", device:"${ctx.start.udid}" }.`,
    endedAt: Date.now(),
  });
}
