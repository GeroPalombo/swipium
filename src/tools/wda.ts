import { z } from 'zod';
import { spawn } from 'node:child_process';
import { existsSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { consumeConsent, requireConsent } from '../consent/consent.js';
import { sensitiveRefusal } from '../lib/sensitive.js';
import { run } from '../lib/spawn.js';
import {
  checkWda,
  classifyWdaBuildFailure,
  classifyWdaConnectionFailure,
  createWdaSession,
  discoverWdaProjects,
  managedWdaBuildArgs,
  managedWdaStartArgs,
  waitForWdaReady,
  wdaSessionUdidMismatch,
  xcodeAvailable,
} from '../lib/wda.js';
import { loadWdaConfig, wdaSigningStatus, wdaUrlAllowedByConfig } from '../lib/wdaConfig.js';
import { recordWdaTiming, wdaRecommendations, wdaTimingSummary } from '../lib/wdaTune.js';
import { WdaDriver } from '../drivers/WdaDriver.js';
import * as sim from '../lib/simctl.js';
import { registerManagedProcess, unregisterManagedProcess } from '../session/processRegistry.js';
import type { ArtifactRecord, Session, SessionStore } from '../session/store.js';

const managedProcesses = new Map<string, { pid: number; logUri: string }>();

interface WdaDiagnosticIssue {
  code: string;
  severity: 'blocker' | 'warn';
  detail: string;
  nextStep: string;
  failureCode?: string;
}

function isLoopback(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}

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
        'Diagnose, attach, or manage an iOS WebDriverAgent backend. External WDA: pass webDriverAgentUrl, then action:"attach". Managed WDA: pass wdaProjectPath + udid for build/start; output is captured as artifacts.',
      inputSchema: {
        sessionId: z.string(),
        action: z.enum(['status', 'doctor', 'build', 'start', 'stop', 'attach', 'diagnose', 'logs', 'tune']),
        webDriverAgentUrl: z
          .string()
          .optional()
          .describe('External WDA base URL. Defaults to http://127.0.0.1:8100. Non-loopback URLs are refused by default.'),
        udid: z
          .string()
          .optional()
          .describe('iOS simulator UDID expected behind this WDA endpoint (this tool is iOS-only; other tools use `device`).'),
        bundleId: z.string().optional().describe('App bundle id for session creation. Defaults to the session appId.'),
        wdaProjectPath: z
          .string()
          .optional()
          .describe('Path to WebDriverAgent.xcodeproj for managed build/start. Relative paths resolve from project root.'),
        derivedDataPath: z
          .string()
          .optional()
          .describe('Optional xcodebuild -derivedDataPath for WDA caching/reuse. Relative paths resolve from project root.'),
        scheme: z.string().optional().describe('WDA xcodebuild scheme. Defaults to WebDriverAgentRunner.'),
        allowNonLoopback: z.boolean().optional().describe('Required to use a non-loopback external WDA URL.'),
        consentId: z.string().optional(),
        approve: z.boolean().optional(),
      },
    },
    async ({
      sessionId,
      action,
      webDriverAgentUrl,
      udid,
      bundleId,
      wdaProjectPath,
      derivedDataPath,
      scheme,
      allowNonLoopback,
      consentId,
      approve,
    }) => {
      const session = sessions.get(sessionId);
      if (!session)
        return qaError({
          what: `Unknown sessionId ${sessionId}`,
          changedState: false,
          retrySafe: true,
          nextSteps: ['Call qa_start_session first.'],
        });

      const configured = loadWdaConfig(session.root);
      const url = webDriverAgentUrl ?? configured.url;
      const loopback = isLoopback(url);
      const configAllowed = !loopback && wdaUrlAllowedByConfig(configured, url);
      if (!loopback && !allowNonLoopback && !configAllowed) {
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
        const gate = consumeConsent(consentId, approve, { action: 'wda_non_loopback', affects: { url } });
        if (!gate.approved) {
          return requireConsent({
            action: 'wda_non_loopback',
            risk: 'medium',
            exactCommand: `connect to WebDriverAgent at ${url}`,
            affects: { url },
            explain: `Use non-loopback WebDriverAgent URL ${url}? WDA is an automation server; only approve this on a trusted, isolated network.`,
          });
        }
      }

      const resolvePath = (p: string | undefined) => (p ? (isAbsolute(p) ? p : join(session.root, p)) : undefined);
      const projectPath = resolvePath(wdaProjectPath);
      const ddPath = resolvePath(derivedDataPath) ?? configured.derivedDataPath;
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
          { webDriverAgentUrl: url, wdaConfig: configured, timings, recommendations },
          recommendations.length
            ? `WDA tuning recommendations:\n${recommendations.map((r) => `  - ${r.setting}=${JSON.stringify(r.value)}: ${r.reason}`).join('\n')}`
            : 'WDA tuning: no recommendations from current session evidence.',
        );
      }

      if (action === 'stop') {
        const proc = managedProcesses.get(session.id);
        if (!proc) return qaOk({ stopped: false }, 'no managed WDA process recorded for this session');
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

      if (action === 'build' || action === 'start') {
        if (!targetUdid) {
          return qaError({
            what: `qa_wda ${action} requires a simulator/device UDID`,
            changedState: false,
            retrySafe: true,
            failureCode: 'NO_DEVICE',
            nextSteps: ['Boot/select a simulator with qa_ios boot, or pass udid explicitly.'],
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
                wdaConfig: configured,
                reuseCheckMs,
              },
              `reused existing WDA at ${url}; /status is ready\nNext: qa_wda attach.`,
            );
          }
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
              nextSteps: ['Pass wdaProjectPath, for example path/to/WebDriverAgent.xcodeproj.'],
            },
            { xcode, wdaProjectPath: projectPath ?? null },
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
          sessions.milestone(session, 'wda_build_start');
          const r = await run('xcodebuild', args, { timeoutMs: 180000 });
          sessions.milestone(session, 'wda_build_end');
          const log = `${r.stdout}\n${r.stderr}`;
          const logUri = sessions.saveArtifact(
            session,
            'wda',
            `wda-build-${Date.now()}.log`,
            log,
            'text/plain',
            `WDA build ${r.code === 0 ? 'success' : 'failed'}`,
          );
          sessions.addEnvChange(session, `wda build ${projectPath} ${targetUdid}`);
          if (r.code !== 0) {
            const failureCode = classifyWdaBuildFailure(log);
            sessions.recordMutation(session, {
              tool: 'qa_wda',
              action: 'wda_build',
              risk: 'medium',
              target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
              consent: { required: true, consentId, approved: true },
              status: 'blocked',
              ledgerUri: logUri,
              detail: `${failureCode}: exit ${r.code}`,
            });
            return qaError(
              {
                what:
                  failureCode === 'WDA_SIGNING_FAILED'
                    ? `WDA signing/provisioning failed with exit ${r.code}`
                    : `WDA build failed with exit ${r.code}`,
                changedState: true,
                retrySafe: failureCode !== 'WDA_SIGNING_FAILED',
                failureCode,
                artifactUri: logUri,
                nextSteps:
                  failureCode === 'WDA_SIGNING_FAILED'
                    ? [
                        'Open the WDA build log artifact, configure a valid development team/certificate/provisioning profile for the device, then retry.',
                      ]
                    : ['Open the WDA build log artifact, fix the Xcode build error, then retry.'],
              },
              { xcode, logUri, timedOut: r.timedOut },
            );
          }
          sessions.recordMutation(session, {
            tool: 'qa_wda',
            action: 'wda_build',
            risk: 'medium',
            target: { udid: targetUdid, projectPath, derivedDataPath: ddPath, scheme: scheme ?? null },
            consent: { required: true, consentId, approved: true },
            status: 'executed',
            ledgerUri: logUri,
          });
          return qaOk(
            { built: true, logUri, xcode, command: ['xcodebuild', ...args], wdaConfig: configured },
            `WDA build completed → ${logUri}`,
          );
        }
        const logUri = sessions.saveArtifact(session, 'wda', `wda-start-${Date.now()}.log`, '', 'text/plain', 'WDA start log');
        const rec = sessions.findArtifact(logUri)!;
        const fd = openSync(rec.rec.path, 'a');
        sessions.milestone(session, 'wda_start_start');
        const child = spawn('xcodebuild', args, { detached: true, stdio: ['ignore', fd, fd] });
        sessions.milestone(session, 'wda_start_end');
        child.unref();
        managedProcesses.set(session.id, { pid: child.pid ?? -1, logUri });
        registerManagedProcess(child.pid, 'wda', session.id); // reapable if this server crashes
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
        const waited = await waitForWdaReady(url, configured.startupTimeoutMs);
        sessions.addMilestoneDuration(session, 'wda_startup_wait_ms', waited.durationMs);
        if (!waited.ready) {
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
            detail: `WDA not ready after ${configured.startupTimeoutMs}ms`,
          });
          return qaError(
            {
              what: `Managed WDA did not become ready at ${url} within ${configured.startupTimeoutMs}ms`,
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
              wdaConfig: configured,
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
            command: ['xcodebuild', ...args],
            wdaConfig: configured,
            wda: waited.status,
            startupWaitMs: waited.durationMs,
          },
          `started managed WDA pid ${child.pid ?? 'unknown'} and /status is ready → ${logUri}\nNext: qa_wda attach.`,
        );
      }

      const status = await checkWda(url);
      const xcode = await xcodeAvailable();
      const bootedUdid = session.device ?? udid ?? null;
      const appId = bundleId ?? session.appId ?? null;
      const artifactSummary = latestWdaArtifacts(session);
      const wdaProjectDiscovery = discoverWdaProjects(session.root, projectPath ? [projectPath] : []);
      const wdaBuildProduct = configured.mode === 'managed' || !!projectPath ? managedWdaBuildProductStatus(ddPath) : null;
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
        wdaConfig: configured,
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
              'Boot/select a simulator with qa_ios boot, or pass udid for an already-running WDA target.',
            ),
          );
        }
        if (!bootedUdid)
          issues.push(
            issue(
              'NO_UDID',
              'no simulator/device UDID is bound to this session',
              'Boot/select a simulator with qa_ios boot, or pass udid explicitly.',
            ),
          );
        if (wantsManaged && (!projectPath || !existsSync(projectPath))) {
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
              'Pass udid explicitly, or bind the session to a device first. This prevents attaching to a stale WDA for the wrong device.',
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
            consent: { required: !loopback && !configAllowed, consentId, approved: loopback || configAllowed || !!approve },
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
          consent: { required: !loopback && !configAllowed, consentId, approved: true },
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
          consent: { required: !loopback && !configAllowed, consentId, approved: loopback || configAllowed || !!approve },
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
