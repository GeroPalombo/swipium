// qa_doctor: proactive environment self-diagnosis. Run first.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qaOk } from '../lib/result.js';
import { getSchemaHash } from '../lib/schemaHash.js';
import { which, firstLine, adbDevices, listAvds, deviceFreeDataBytes, fmtBytes, androidSdkCandidates } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { checkWda, discoverWdaProjects, xcodeAvailable } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { SWIPIUM_VERSION, TOOL_NAMES, TOOL_COUNT, STALE_CLIENT_HINT } from '../version.js';
import { codexEnvChecks, codexEnvVarsLine, isCodexClient } from '../lib/codexEnv.js';

export interface Check {
  name: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
  fix?: string;
}

const CLIENT_HINTS: Record<string, string> = {
  claude: 'Register with: claude mcp add swipium --scope project -- npx -y swipium (preview: `swipium init claude --scope project`).',
  gemini:
    'Register with: gemini mcp add swipium npx -y swipium (project scope), or add to .gemini/settings.json mcpServers with "cwd" set to your app repo. Preview: `swipium init gemini`.',
  codex:
    'Register with `swipium init codex` (writes cwd, startup_timeout_sec/tool_timeout_sec and env_vars to ~/.codex/config.toml) or `codex mcp add swipium -- npx -y swipium` plus those keys by hand. Codex does not inherit your shell env: list SWIPIUM_TEST_*, ANDROID_HOME, JAVA_HOME etc. in env_vars (approval grants like SWIPIUM_CONSENT_PREAPPROVE go literally in env = { ... }). Codex Desktop threads may not expose custom stdio MCP tools (openai/codex#19425), so confirm the tools appear.',
  cursor:
    'Add to .cursor/mcp.json under "mcpServers": { "swipium": { "command": "npx", "args": ["-y", "swipium"], "env": { "SWIPIUM_PROJECT_ROOT": "${workspaceFolder}" } } } (or run `swipium init cursor --apply`).',
  vscode:
    'Add to .vscode/mcp.json under "servers" (not "mcpServers"): { "swipium": { "type": "stdio", "command": "npx", "args": ["-y", "swipium"], "env": { "SWIPIUM_PROJECT_ROOT": "${workspaceFolder}" } } } (or run `swipium init vscode --apply`).',
};

type DoctorPlatform = 'android' | 'ios' | 'both';

/** Default doctor scope when the caller gives none: iOS Simulator only exists on macOS. */
export function defaultDoctorPlatform(hostPlatform: NodeJS.Platform = process.platform): DoctorPlatform {
  return hostPlatform === 'darwin' ? 'both' : 'android';
}

/** Minimum Node major version, mirrored from package.json "engines.node" (>=20). */
export const MIN_NODE_MAJOR = 20;

export function nodeVersionCheck(version: string = process.version, minMajor: number = MIN_NODE_MAJOR): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? NaN);
  const ok = Number.isFinite(major) && major >= minMajor;
  return {
    name: 'node',
    ok,
    detail: ok ? `${version} (>= ${minMajor})` : `${version} is below the supported minimum (>= ${minMajor})`,
    fix: ok
      ? undefined
      : `Install Node.js ${minMajor} or newer (the client launches the server with the node on its PATH or the absolute path in its config).`,
  };
}

function checkLine(c: Check): string {
  const status = c.ok ? '[ok]' : c.optional ? '[warn]' : '[fail]';
  return `${status} ${c.name}: ${c.detail}${c.fix && !c.ok ? ` -> ${c.fix}` : ''}`;
}

function wdaBuildProductStatus(derivedDataPath: string): { built: boolean; productPath?: string; checkedPath: string } {
  if (!existsSync(derivedDataPath)) return { built: false, checkedPath: derivedDataPath };
  const stack: Array<{ path: string; depth: number }> = [{ path: derivedDataPath, depth: 0 }];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur.depth > 6) continue;
    let entries: string[];
    try {
      entries = readdirSync(cur.path);
    } catch {
      continue;
    }
    for (const name of entries) {
      const p = join(cur.path, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (!st.isDirectory()) continue;
      if (/WebDriverAgentRunner.*\.app$/i.test(name)) return { built: true, productPath: p, checkedPath: derivedDataPath };
      stack.push({ path: p, depth: cur.depth + 1 });
    }
  }
  return { built: false, checkedPath: derivedDataPath };
}

export function registerDoctor(server: McpServer): void {
  server.registerTool(
    'qa_doctor',
    {
      title: 'QA environment doctor',
      description:
        'Check the local toolchain (Node, Android SDK/emulator, Xcode/simctl, WDA) and stale-client symptoms. Run it first ' +
        'when setup fails.',
      inputSchema: {
        platform: z.enum(['android', 'ios', 'both']).optional().describe('Default both on macOS (ready if either is), else android.'),
        client: z.enum(['claude', 'gemini', 'codex', 'cursor', 'vscode']).optional().describe('Tailor setup hints to this MCP client.'),
        expectedToolCount: z.number().optional().describe('Tool count you expect; a mismatch means a stale client.'),
        expectedVersion: z.string().optional().describe('Version you expect; a mismatch means a stale client.'),
        expectedSchemaHash: z.string().optional().describe('Surface hash you expect; a mismatch means a stale client.'),
      },
    },
    async ({ platform, client, expectedToolCount, expectedVersion, expectedSchemaHash }) => {
      const defaulted = platform === undefined;
      const requested = (platform ?? defaultDoctorPlatform()) as DoctorPlatform;
      const wantsAndroid = requested === 'android' || requested === 'both';
      const wantsIos = requested === 'ios' || requested === 'both';
      const checks: Check[] = [];
      const androidChecks: Check[] = [];
      const iosChecks: Check[] = [];
      const schemaHash = getSchemaHash();

      // Stale-client detection (P1.8 + 3.3 A): the agent (via docs) tells us what it expects; we are
      // the source of truth. Version is for humans; the schema hash catches "same count, different
      // surface" after a behavior/schema/description change.
      const versionMismatch = expectedVersion != null && expectedVersion !== SWIPIUM_VERSION;
      const toolCountMismatch = expectedToolCount != null && expectedToolCount !== TOOL_COUNT;
      const schemaHashMismatch = expectedSchemaHash != null && expectedSchemaHash !== schemaHash;
      if (expectedToolCount != null || expectedVersion != null || expectedSchemaHash != null) {
        const ok = !versionMismatch && !toolCountMismatch && !schemaHashMismatch;
        checks.push({
          name: 'client-freshness',
          ok,
          detail: ok
            ? `client matches running server (v${SWIPIUM_VERSION}, ${TOOL_COUNT} tools, schema ${schemaHash})`
            : `STALE CLIENT: running v${SWIPIUM_VERSION}/${TOOL_COUNT} tools/schema ${schemaHash} but client expected ${expectedVersion ?? '?'}/${expectedToolCount ?? '?'}/${expectedSchemaHash ?? '?'}`,
          fix: ok ? undefined : STALE_CLIENT_HINT,
        });
      }

      checks.push(nodeVersionCheck());
      const nodeOk = checks[checks.length - 1].ok;

      let devices: string[] = [];
      let androidSdkFound: boolean | null = null;
      let javaFound: boolean | null = null;
      let avds: string[] = [];
      let androidReady = true;
      if (wantsAndroid) {
        // PATH lookup: at startup src/index.ts prepends the SDK's platform-tools/ and emulator/
        // ($ANDROID_HOME, $ANDROID_SDK_ROOT, OS default) to PATH, so this sees SDK copies too.
        const hasAdb = await which('adb');
        const sdkCandidates = androidSdkCandidates();
        const sdkDirs = sdkCandidates.join(', ');
        androidSdkFound = hasAdb || sdkCandidates.some((d) => existsSync(d));
        androidChecks.push({
          name: 'adb',
          ok: hasAdb,
          detail: hasAdb ? ((await firstLine('adb', ['version'])) ?? 'present') : `not on PATH (SDK dirs checked: ${sdkDirs})`,
          fix: hasAdb
            ? undefined
            : 'Install Android platform-tools (Android Studio > SDK Manager) and set ANDROID_HOME to the SDK dir (or put platform-tools on PATH).',
        });

        devices = hasAdb ? await adbDevices() : [];
        const deviceDetails = await Promise.all(
          devices.map(async (d) => {
            const free = await deviceFreeDataBytes(d);
            const low = free != null && free < 600 * 1024 * 1024;
            return `${d} (/data free: ${fmtBytes(free)}${low ? ' low' : ''})`;
          }),
        );
        const anyLowSpace = deviceDetails.some((d) => d.includes(' low'));
        androidChecks.push({
          name: 'device-online',
          ok: devices.length > 0,
          optional: true,
          detail: devices.length ? deviceDetails.join(', ') : 'no device/emulator online',
          fix: devices.length
            ? anyLowSpace
              ? 'Low /data space: reboot the emulator with `-wipe-data -partition-size 8192` before installing large RN APKs.'
              : undefined
            : 'Boot an emulator, or let qa_prepare_target boot an available AVD.',
        });

        const hasEmulator = await which('emulator');
        avds = hasEmulator ? await listAvds() : [];
        androidChecks.push({
          name: 'emulator+avd',
          ok: hasEmulator && avds.length > 0,
          optional: devices.length > 0,
          detail: hasEmulator
            ? avds.length
              ? `AVDs: ${avds.join(', ')}`
              : 'emulator present, no AVDs'
            : `emulator not on PATH (SDK dirs checked: ${sdkDirs})`,
          fix:
            hasEmulator && avds.length === 0
              ? 'Create an AVD with Android Studio or avdmanager.'
              : hasEmulator
                ? undefined
                : 'Install the Android Emulator package via Android Studio or sdkmanager.',
        });

        androidChecks.push({
          name: 'android-target',
          ok: devices.length > 0 || (hasEmulator && avds.length > 0),
          detail:
            devices.length > 0
              ? 'online device/emulator available'
              : hasEmulator && avds.length > 0
                ? 'bootable AVD available'
                : 'no online target or bootable AVD',
          fix:
            devices.length > 0 || (hasEmulator && avds.length > 0)
              ? undefined
              : 'Create or boot an Android Emulator, then rerun qa_doctor.',
        });

        const java = await firstLine('java', ['-version']);
        javaFound = java !== null;
        androidChecks.push({
          name: 'java',
          ok: java !== null,
          optional: true,
          detail: java ?? 'not found (only needed for build-from-source / native Android builds)',
        });

        checks.push(...androidChecks);
        androidReady = androidChecks.filter((c) => !c.optional).every((c) => c.ok);
      }

      let simulators: Awaited<ReturnType<typeof listSimulators>> = [];
      let iosReady = true;
      let wdaSummary: Record<string, unknown> | undefined;
      if (wantsIos) {
        const xcode = await xcodeAvailable();
        iosChecks.push({
          name: 'xcodebuild',
          ok: xcode.available,
          detail: xcode.available ? (xcode.version ?? 'present') : (xcode.error ?? 'not available'),
          fix: xcode.available ? undefined : 'Install Xcode and select it with `xcode-select`.',
        });
        const simctlOk = await simctlAvailable();
        iosChecks.push({
          name: 'simctl',
          ok: simctlOk,
          detail: simctlOk ? 'available' : 'xcrun simctl unavailable',
          fix: simctlOk ? undefined : 'Install Xcode command line tools and an iOS simulator runtime.',
        });
        simulators = simctlOk ? await listSimulators() : [];
        const booted = simulators.filter((s) => s.state === 'Booted');
        iosChecks.push({
          name: 'ios-simulator',
          ok: simulators.length > 0,
          detail: simulators.length ? `${booted.length} booted, ${simulators.length} available` : 'no iOS simulators available',
          fix: simulators.length ? undefined : 'Install an iOS Simulator runtime in Xcode and create a simulator.',
        });

        // The WDA cache/config live under the PROJECT root (SWIPIUM_PROJECT_ROOT / MCP roots / cwd
        // marker), not blindly the server cwd.
        const root = (await resolveProjectRoot(server)).root ?? process.cwd();
        const wdaConfig = loadWdaConfig(root);
        const wda = await checkWda(wdaConfig.url, 1200);
        const discovery = discoverWdaProjects(root);
        const wdaProduct = wdaBuildProductStatus(wdaConfig.derivedDataPath);
        iosChecks.push({
          name: 'wda-server',
          ok: wda.reachable && wda.ready,
          optional: true,
          detail: wda.reachable
            ? `${wda.ready ? 'ready' : 'reachable but not ready'} at ${wdaConfig.url}`
            : `not reachable at ${wdaConfig.url}`,
          fix:
            wda.reachable && wda.ready
              ? undefined
              : 'For structured iOS flows, run qa_wda doctor/build/start or attach an external WDA URL.',
        });
        iosChecks.push({
          name: 'wda-project-cache',
          ok: discovery.candidates.length > 0 || wdaProduct.built,
          optional: true,
          detail: wdaProduct.built
            ? `built product: ${wdaProduct.productPath}`
            : discovery.candidates.length
              ? `project candidates: ${discovery.candidates.slice(0, 3).join(', ')}`
              : `no WDA project found; checked cache ${wdaProduct.checkedPath}`,
          fix:
            discovery.candidates.length > 0 || wdaProduct.built
              ? undefined
              : 'Install appium-webdriveragent or configure ios.wda.derivedDataPath / wdaProjectPath.',
        });
        checks.push(...iosChecks);
        iosReady = iosChecks.filter((c) => !c.optional).every((c) => c.ok);
        wdaSummary = {
          projectRoot: root,
          config: { url: wdaConfig.url, mode: wdaConfig.mode, derivedDataPath: wdaConfig.derivedDataPath },
          status: wda,
          projectDiscovery: discovery,
          buildProduct: wdaProduct,
        };
      }

      // Codex hands stdio servers a fixed env whitelist (see lib/codexEnv.ts): explain it, flag a
      // missing ANDROID_HOME/JAVA_HOME, and remind about tool_timeout_sec (not readable from here).
      const codex = isCodexClient(server.server.getClientVersion()?.name) || client === 'codex';
      if (codex) checks.push(...codexEnvChecks({ env: process.env, androidSdkFound, javaFound }));

      // An explicit platform:"both" means "both must work"; the macOS default only needs one of them
      // (an iOS-only or Android-only developer on a Mac must not be told the environment is broken).
      const platformOk =
        requested === 'android'
          ? androidReady
          : requested === 'ios'
            ? iosReady
            : defaulted
              ? androidReady || iosReady
              : androidReady && iosReady;
      const requiredOk = platformOk && nodeOk;
      const clientHint = client ? CLIENT_HINTS[client] : undefined;

      const table = checks.map(checkLine).join('\n');
      const readyLabel = requested === 'both' && defaulted && !(androidReady && iosReady) ? (androidReady ? 'android' : 'ios') : requested;

      const summary =
        `Swipium v${SWIPIUM_VERSION} · ${TOOL_COUNT} tools · schema ${schemaHash}\n${STALE_CLIENT_HINT}\n\n` +
        `${requiredOk ? `Environment ready for ${readyLabel} simulator QA.` : `Environment NOT ready for ${requested} simulator QA. See [fail] rows.`}\n${table}` +
        (codex ? `\n\nCodex: forward shell env with this line under [mcp_servers.swipium]:\n${codexEnvVarsLine()}` : '');

      return qaOk(
        {
          swipiumVersion: SWIPIUM_VERSION,
          schemaHash,
          toolSurface: { count: TOOL_COUNT, tools: TOOL_NAMES },
          platform: requested,
          ready: requiredOk,
          platformReady: { android: wantsAndroid ? androidReady : null, ios: wantsIos ? iosReady : null },
          clientFreshness:
            expectedToolCount != null || expectedVersion != null || expectedSchemaHash != null
              ? {
                  stale: versionMismatch || toolCountMismatch || schemaHashMismatch,
                  runningVersion: SWIPIUM_VERSION,
                  runningToolCount: TOOL_COUNT,
                  runningSchemaHash: schemaHash,
                  expectedVersion: expectedVersion ?? null,
                  expectedToolCount: expectedToolCount ?? null,
                  expectedSchemaHash: expectedSchemaHash ?? null,
                }
              : undefined,
          checks,
          checksByPlatform: { android: androidChecks, ios: iosChecks },
          devicesOnline: devices,
          avds,
          simulators: wantsIos ? simulators : undefined,
          wda: wdaSummary,
          ...(clientHint ? { clientHint } : {}),
          ...(codex
            ? { codex: { envVarsLine: codexEnvVarsLine(), toolTimeoutSec: '>= 600 (set in config.toml; not readable by the server)' } }
            : {}),
        },
        summary,
      );
    },
  );
}
