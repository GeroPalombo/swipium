import { z } from 'zod';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import { cancelledResult, qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { isAbortError, runWithSignal } from '../lib/abortScope.js';
import { consumeConsent, requireConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { run } from '../lib/spawn.js';
import {
  checkWda,
  classifyWdaBuildFailure,
  classifyWdaConnectionFailure,
  createWdaSession,
  discoverAppiumWdaProjects,
  discoverWdaProjects,
  managedWdaBuildArgs,
  managedWdaStartArgs,
  waitForWdaReady,
  wdaSessionUdidMismatch,
  xcodeAvailable,
  isLoopbackWdaUrl,
  remoteWdaAllowedByUser,
  REMOTE_WDA_ENV,
} from '../lib/wda.js';
import { loadWdaConfig, wdaSigningStatus, wdaUrlAllowedByConfig } from '../lib/wdaConfig.js';
import { recordWdaTiming, wdaRecommendations, wdaTimingSummary } from '../lib/wdaTune.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import * as sim from '../lib/simctl.js';
import {
  findManagedWdaProcesses,
  killManagedWda,
  reclaimPid,
  registerManagedProcess,
  registeredWdaForSession,
  unregisterManagedProcess,
  type ManagedWdaSignature,
} from '../session/processRegistry.js';
import type { ArtifactRecord, JobRecord, Session, SessionStore } from '../session/store.js';

/** qa_wda actions that run xcodebuild and are consent-gated as `wda_<name>` (CONSENT_ACTIONS in consent.ts). */
export const WDA_XCODEBUILD_ACTIONS = ['build', 'start'] as const;
function isWdaXcodebuildAction(a: string): a is (typeof WDA_XCODEBUILD_ACTIONS)[number] {
  return (WDA_XCODEBUILD_ACTIONS as readonly string[]).includes(a);
}

/** How long `qa_wda start` blocks inside ONE tool call waiting for /status. One call must stay
 *  under common client tool timeouts (Codex: 60 s), so a slower start returns status:"starting"
 *  and the agent polls with qa_wait { for:"wda_ready" } (bounded by ios.wda.startupTimeoutMs). */
export const WDA_START_CALL_WAIT_MS = 45_000;
/** Kill timer for the background `qa_wda build` job (a cold WDA build-for-testing is slow). */
export const WDA_BUILD_TIMEOUT_MS = 600_000;

const managedProcesses = new Map<string, { pid: number; logUri: string }>();

function pidIsAlive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A managed WDA this server still runs for the session (started here, or adopted at startup).
 *  A dead in-memory entry is dropped. */
function liveManagedWda(sessionId: string): { pid: number; adopted: boolean } | undefined {
  const own = managedProcesses.get(sessionId);
  if (own) {
    if (pidIsAlive(own.pid)) return { pid: own.pid, adopted: false };
    managedProcesses.delete(sessionId);
    unregisterManagedProcess(own.pid);
  }
  const adopted = registeredWdaForSession(sessionId);
  return adopted && pidIsAlive(adopted.pid) ? { pid: adopted.pid, adopted: true } : undefined;
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

/** The WDA URL to probe for this session: the attached WdaDriver's, else the URL of the latest
 *  executed `qa_wda start` (both already passed the loopback/consent gate), else the configured
 *  one (source 'config': the caller must apply the non-loopback gate). Exported for qa_wait. */
export function wdaUrlForSession(session: Session): { url: string; source: 'driver' | 'wda_start' | 'config' } {
  if (session.driver instanceof WdaDriver) return { url: session.driver.baseUrl, source: 'driver' };
  const m = [...(session.mutations ?? [])]
    .reverse()
    .find(
      (r) => r.tool === 'qa_wda' && r.action === 'wda_start' && r.status === 'executed' && typeof r.target?.webDriverAgentUrl === 'string',
    );
  if (m) return { url: String(m.target!.webDriverAgentUrl), source: 'wda_start' };
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
      title: 'WebDriverAgent diagnostics and attach',
      description:
        'Manage the iOS WebDriverAgent backend behind structured iOS tap/type/snapshot: attach an external WDA ' +
        '(webDriverAgentUrl), build/start a managed one (consent-gated), stop it; status/doctor/diagnose/logs/tune inspect ' +
        'the setup. build runs as a background job (poll qa_job_status); start waits up to 45 s, then returns status:"starting" ' +
        '(poll qa_wait { for:"wda_ready" }).',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'doctor', 'build', 'start', 'stop', 'attach', 'diagnose', 'logs', 'tune']),
        webDriverAgentUrl: z.string().optional().describe('Default http://127.0.0.1:8100; non-loopback needs allowNonLoopback + consent.'),
        device: z.string().optional().describe('Simulator UDID (default: session device).'),
        udid: z.string().optional().describe('Deprecated alias of device.'),
        bundleId: z.string().optional().describe('Default: the session appId.'),
        wdaProjectPath: z.string().optional().describe('WebDriverAgent.xcodeproj (default: Appium WDA if found).'),
        derivedDataPath: z.string().optional().describe('xcodebuild -derivedDataPath for reuse.'),
        scheme: z.string().optional().describe('Default WebDriverAgentRunner.'),
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
      const udid = device ?? udidAlias;

      const configured = loadWdaConfig(session.root);
      const url = webDriverAgentUrl ?? configured.url;
      const loopback = isLoopback(url);
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
      const targetUdid = udid ?? session.device;
      if (udid && session.device && udid !== session.device) {
        return qaError({
          what: `Refused ambiguous WDA/device mapping: session is bound to ${session.device}, but qa_wda was asked to use ${udid}`,
          changedState: false,
          retrySafe: false,
          failureCode: 'STALE_WDA_DEVICE',
          nextSteps: ['Use the session-bound UDID, or start a separate session for the other simulator/device.'],
        });
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
          const adopted = registeredWdaForSession(session.id);
          const outcome = adopted ? reclaimPid(adopted.pid, 'wda', undefined, adopted) : undefined; // fingerprint-checked
          if (adopted) unregisterManagedProcess(adopted.pid);
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
        if (action === 'start' && configured.reuse) {
          const reuseStartedAt = Date.now();
          const existing = await checkWda(url);
          const reuseCheckMs = Date.now() - reuseStartedAt;
          sessions.addMilestoneDuration(session, 'wda_reuse_check_ms', reuseCheckMs);
          if (existing.reachable && existing.ready) {
            return qaOk(
              {
                started: false,
                reused: true,
                ready: true,
                webDriverAgentUrl: url,
                udid: targetUdid,
                wda: existing,
                wdaConfig: effectiveConfig,
                reuseCheckMs,
              },
              `reused existing WDA at ${url}; /status is ready\nNext: qa_wda attach.`,
            );
          }
        }
        // Never start a second managed xcodebuild over a live one: the new runner would fight it
        // for the port and the old one would be orphaned (managedProcesses would be overwritten).
        const running = action === 'start' ? liveManagedWda(session.id) : undefined;
        if (running) {
          return qaError(
            {
              what: `A managed WDA (pid ${running.pid}${running.adopted ? ', adopted from a previous server run' : ''}) is already running for this session`,
              changedState: false,
              retrySafe: true,
              failureCode: 'WDA_START_FAILED',
              nextSteps: ['Use it (qa_wda attach), or stop it first with qa_wda { action:"stop" } and retry start.'],
            },
            { managedPid: running.pid, adopted: running.adopted, webDriverAgentUrl: url },
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
        const args =
          action === 'build'
            ? managedWdaBuildArgs({
                projectPath,
                udid: targetUdid,
                derivedDataPath: ddPath,
                scheme,
                developmentTeam: configured.developmentTeam,
              })
            : managedWdaStartArgs({
                projectPath,
                udid: targetUdid,
                derivedDataPath: ddPath,
                scheme,
                developmentTeam: configured.developmentTeam,
              });
        const gate = consumeConsent(consentId, approve, { action: `wda_${action}`, affects: { udid: targetUdid, projectPath } });
        if (!gate.approved) {
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: `wda_${action}`,
            risk: 'medium',
            target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
            consent: { required: true, approved: false },
            status: 'requested',
          });
          return requireConsent({
            action: `wda_${action}`,
            risk: 'medium',
            exactCommand: `xcodebuild ${args.join(' ')}`,
            affects: { udid: targetUdid, projectPath },
            explain: `${action === 'build' ? 'Build' : 'Start'} WebDriverAgent with xcodebuild? This can use local signing context and run for a while.`,
          });
        }
        sessions.recordMutation(session, {
          tool: 'qa_wda',
          action: `wda_${action}`,
          risk: 'medium',
          target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
          consent: { required: true, consentId, approved: true },
          status: 'approved',
        });
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
            wdaConfig: effectiveConfig,
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
        const logUri = sessions.saveArtifact(session, 'wda', `wda-start-${Date.now()}.log`, '', 'text/plain', 'WDA start log');
        const rec = sessions.findArtifact(logUri)!;
        const fd = openSync(rec.rec.path, 'a');
        sessions.milestone(session, 'wda_start_start');
        let child;
        try {
          child = spawn('xcodebuild', args, { detached: true, stdio: ['ignore', fd, fd] });
        } finally {
          closeSync(fd); // the child holds its own duplicate; ours would leak one fd per start
        }
        sessions.milestone(session, 'wda_start_end');
        child.on('error', () => undefined); // spawn failure surfaces as WDA_START_FAILED below, not a crash
        child.unref();
        managedProcesses.set(session.id, { pid: child.pid ?? -1, logUri });
        // Reapable if this server crashes; `endpoint` lets the next server adopt it when healthy.
        registerManagedProcess(child.pid, 'wda', session.id, { endpoint: url });
        sessions.addEnvChange(session, `wda start pid ${child.pid ?? 'unknown'} ${projectPath} ${targetUdid}`);
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
            webDriverAgentUrl: url,
          },
          consent: { required: true, consentId, approved: true },
          status: 'executed',
          ledgerUri: logUri,
          detail: 'managed WDA process started',
        });
        // Cancelled while waiting: WDA stays started (managed + registered, so the next attach can
        // adopt it); report CANCELLED, not a WDA startup failure.
        // Bounded in-call wait: at most WDA_START_CALL_WAIT_MS here; the rest of the configured
        // startupTimeoutMs is polled by the agent via qa_wait { for:"wda_ready" }.
        const callWaitMs = Math.min(configured.startupTimeoutMs, WDA_START_CALL_WAIT_MS);
        const waited = await waitForWdaReady(url, callWaitMs).catch((e: unknown) => {
          if (isAbortError(e)) return null;
          throw e;
        });
        if (!waited) return cancelledResult('qa_wda start cancelled while waiting for WDA; the managed WDA process was left running', true);
        sessions.addMilestoneDuration(session, 'wda_startup_wait_ms', waited.durationMs);
        const remainingMs = configured.startupTimeoutMs - waited.durationMs;
        if (!waited.ready && remainingMs > 0 && pidIsAlive(child.pid ?? -1)) {
          return qaOk(
            {
              started: true,
              ready: false,
              status: 'starting',
              pid: child.pid ?? null,
              logUri,
              webDriverAgentUrl: url,
              wdaProjectPath: projectPath,
              wdaProjectSource,
              command: ['xcodebuild', ...args],
              wdaConfig: effectiveConfig,
              wda: waited.status,
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
              webDriverAgentUrl: url,
            },
            consent: { required: true, consentId, approved: true },
            status: 'blocked',
            ledgerUri: logUri,
            detail: why,
          });
          return qaError(
            {
              what: exited
                ? `Managed WDA exited before becoming ready at ${url} (waited ${waited.durationMs}ms)`
                : `Managed WDA did not become ready at ${url} within ${configured.startupTimeoutMs}ms`,
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
              webDriverAgentUrl: url,
              command: ['xcodebuild', ...args],
              wdaConfig: effectiveConfig,
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
            webDriverAgentUrl: url,
            wdaProjectPath: projectPath,
            wdaProjectSource,
            command: ['xcodebuild', ...args],
            wdaConfig: effectiveConfig,
            wda: waited.status,
            startupWaitMs: waited.durationMs,
          },
          `started managed WDA pid ${child.pid ?? 'unknown'} and /status is ready > ${logUri}\nNext: qa_wda attach.`,
        );
      }

      const status = await checkWda(url);
      const xcode = await xcodeAvailable();
      const bootedUdid = session.device ?? udid ?? null;
      const appId = bundleId ?? session.appId ?? null;
      const artifactSummary = latestWdaArtifacts(session);
      const wdaProjectDiscovery = discoverWdaProjects(session.root, projectPath ? [projectPath] : []);
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
        wdaConfig: effectiveConfig,
        wdaProjectDiscovery,
        signing: wdaSigningStatus(configured),
        wdaBuildProduct,
        sessionActive: session.driver instanceof WdaDriver,
        driverKind: session.driver?.kind ?? null,
        appInstalled,
        simctlAvailable: simctlOk,
        bootedSimulators: bootedSimulators.map((s) => ({ udid: s.udid, name: s.name, runtime: s.runtime })),
        managedProcess: managedProcesses.get(session.id) ?? null,
        latestLogUri: artifactSummary.latestLog?.uri ?? null,
        latestBuildLogUri: artifactSummary.latestBuildLog?.uri ?? null,
        latestStartLogUri: artifactSummary.latestStartLog?.uri ?? null,
        latestErrorLogUri: artifactSummary.latestErrorLog?.uri ?? null,
        tuning: { timings: wdaTimingSummary(session), recommendations: wdaRecommendations(configured, session) },
      };

      if (action === 'status' || action === 'doctor' || action === 'diagnose') {
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

      // attach
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
            nextSteps: ['Start WebDriverAgent externally, confirm /status responds, then retry qa_wda attach.'],
          },
          base,
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
          { ...base, sessionActive: true, wdaSessionId: created.sessionId, capabilities: created.capabilities ?? null },
          `attached WDA structured iOS backend at ${url}\nNext: qa_snapshot / qa_act / qa_flow_run can use WDA-backed structured operations.`,
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
    },
  );
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
  const signal = sessions.abortSignal(session, job.jobId);
  const upd = (patch: Partial<JobRecord>) => sessions.updateJobIfRunning(session, job, patch);
  const target = { udid: ctx.udid, projectPath: ctx.projectPath, derivedDataPath: ctx.derivedDataPath, scheme: ctx.scheme ?? null };
  const consent = { required: true, consentId: ctx.consentId, approved: true };
  upd({ progress: 'xcodebuild build-for-testing' });
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
    return;
  }
  sessions.milestone(session, 'wda_build_end');
  if (signal?.aborted) return;
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
    return;
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
  const wdaBuildProduct = managedWdaBuildProductStatus(ctx.derivedDataPath);
  upd({
    status: 'done',
    progress: 'done',
    artifactUris: [logUri],
    result: {
      built: true,
      logUri,
      xcode: ctx.xcode,
      command: ['xcodebuild', ...ctx.args],
      wdaConfig: ctx.wdaConfig,
      wdaProjectPath: ctx.projectPath,
      wdaProjectSource: ctx.wdaProjectSource,
      derivedDataPath: ctx.derivedDataPath,
      wdaBuildProduct,
    },
    resultText: `WDA build completed (${ctx.wdaProjectSource === 'appium-discovered' ? 'auto-discovered Appium WDA ' : ''}${ctx.projectPath}) > ${logUri}\nNext: qa_wda start.`,
    endedAt: Date.now(),
  });
}
