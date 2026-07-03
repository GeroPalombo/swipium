// qa_doctor — proactive environment self-diagnosis (DESIGN §3, §7). Run first.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { qaOk } from '../lib/result.js';
import { getSchemaHash } from '../lib/schemaHash.js';
import { which, firstLine, adbDevices, listAvds, deviceFreeDataBytes, fmtBytes } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { checkWda, discoverWdaProjects, xcodeAvailable } from '../lib/wda.js';
import { loadWdaConfig } from '../lib/wdaConfig.js';
import { SWIPIUM_VERSION, TOOL_NAMES, TOOL_COUNT, STALE_CLIENT_HINT } from '../version.js';

interface Check {
  name: string;
  ok: boolean;
  optional?: boolean;
  detail: string;
  fix?: string;
}

const CLIENT_HINTS: Record<string, string> = {
  claude: 'Register with: claude mcp add swipium --scope project -- node <abs>/dist/index.js',
  gemini: 'Add to settings.json mcpServers; set an absolute "command" and a "cwd". stdio cwd is otherwise undefined.',
  codex:
    'Codex has an open tool-injection regression (#19425) on builds after ~0.120.0. Set cwd explicitly, use an absolute node path, and verify tools actually appear after `init codex`.',
};

type DoctorPlatform = 'android' | 'ios' | 'both';

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
        'Probe the local environment for simulator QA prerequisites. Use platform:"android" for Android Emulator, platform:"ios" for iOS Simulator + WDA status, or platform:"both". Pass client to tailor MCP registration hints.',
      inputSchema: {
        platform: z
          .enum(['android', 'ios', 'both'])
          .optional()
          .describe('Which simulator environment to evaluate. Defaults to android for backward compatibility.'),
        client: z.enum(['claude', 'gemini', 'codex']).optional().describe('Optional: tailor hints to a specific MCP client.'),
        expectedToolCount: z
          .number()
          .optional()
          .describe(
            'What your docs/setup expect this server to expose. If it differs from the running server, your client is on a STALE build — restart it.',
          ),
        expectedVersion: z.string().optional().describe('Swipium version your docs expect; mismatch ⇒ stale client.'),
        expectedSchemaHash: z
          .string()
          .optional()
          .describe(
            'Tool-surface hash your docs expect; mismatch ⇒ the client is on a build with a different surface (same tool count can still be stale).',
          ),
      },
    },
    async ({ platform = 'android', client, expectedToolCount, expectedVersion, expectedSchemaHash }) => {
      const requested = platform as DoctorPlatform;
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
            : `STALE CLIENT — running v${SWIPIUM_VERSION}/${TOOL_COUNT} tools/schema ${schemaHash} but client expected ${expectedVersion ?? '?'}/${expectedToolCount ?? '?'}/${expectedSchemaHash ?? '?'}`,
          fix: ok ? undefined : STALE_CLIENT_HINT,
        });
      }

      checks.push({ name: 'node', ok: true, detail: process.version });

      let devices: string[] = [];
      let avds: string[] = [];
      let androidReady = true;
      if (wantsAndroid) {
        const hasAdb = await which('adb');
        androidChecks.push({
          name: 'adb',
          ok: hasAdb,
          detail: hasAdb ? ((await firstLine('adb', ['version'])) ?? 'present') : 'not on PATH',
          fix: hasAdb ? undefined : 'Install Android platform-tools and add to PATH (ANDROID_HOME/platform-tools).',
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
          detail: hasEmulator ? (avds.length ? `AVDs: ${avds.join(', ')}` : 'emulator present, no AVDs') : 'emulator not on PATH',
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

        const root = process.cwd();
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
          config: { url: wdaConfig.url, mode: wdaConfig.mode, derivedDataPath: wdaConfig.derivedDataPath },
          status: wda,
          projectDiscovery: discovery,
          buildProduct: wdaProduct,
        };
      }

      const requiredOk = requested === 'android' ? androidReady : requested === 'ios' ? iosReady : androidReady && iosReady;
      const clientHint = client ? CLIENT_HINTS[client] : undefined;

      const table = checks.map(checkLine).join('\n');

      const summary =
        `Swipium v${SWIPIUM_VERSION} · ${TOOL_COUNT} tools · schema ${schemaHash}\n${STALE_CLIENT_HINT}\n\n` +
        `${requiredOk ? `Environment ready for ${requested} simulator QA.` : `Environment NOT ready for ${requested} simulator QA. See [fail] rows.`}\n${table}`;

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
        },
        summary,
      );
    },
  );
}
