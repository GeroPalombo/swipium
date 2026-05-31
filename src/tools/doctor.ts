// qa_doctor — proactive environment self-diagnosis (DESIGN §3, §7). Run first.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk } from '../lib/result.js';
import { getSchemaHash } from '../lib/schemaHash.js';
import { which, firstLine, adbDevices, listAvds, deviceFreeDataBytes, fmtBytes } from '../lib/android.js';
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

export function registerDoctor(server: McpServer): void {
  server.registerTool(
    'qa_doctor',
    {
      title: 'QA environment doctor',
      description:
        'Probe the local environment for Android mobile-app QA prerequisites (adb, emulator, online devices, AVDs, Java, Node) and report a structured diagnosis with actionable fixes. Run this BEFORE other tools. Pass `client` to tailor registration hints.',
      inputSchema: {
        client: z
          .enum(['claude', 'gemini', 'codex'])
          .optional()
          .describe('Optional: tailor hints to a specific MCP client.'),
        expectedToolCount: z
          .number()
          .optional()
          .describe('What your docs/setup expect this server to expose. If it differs from the running server, your client is on a STALE build — restart it.'),
        expectedVersion: z.string().optional().describe('Swipium version your docs expect; mismatch ⇒ stale client.'),
        expectedSchemaHash: z.string().optional().describe('Tool-surface hash your docs expect; mismatch ⇒ the client is on a build with a different surface (same tool count can still be stale).'),
      },
    },
    async ({ client, expectedToolCount, expectedVersion, expectedSchemaHash }) => {
      const checks: Check[] = [];
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

      const hasAdb = await which('adb');
      checks.push({
        name: 'adb',
        ok: hasAdb,
        detail: hasAdb ? ((await firstLine('adb', ['version'])) ?? 'present') : 'not on PATH',
        fix: hasAdb ? undefined : 'Install Android platform-tools and add to PATH (ANDROID_HOME/platform-tools).',
      });

      const devices = hasAdb ? await adbDevices() : [];
      // Per-device free /data — surfaces the "APK too big for partition" class proactively.
      const deviceDetails = await Promise.all(
        devices.map(async (d) => {
          const free = await deviceFreeDataBytes(d);
          const low = free != null && free < 600 * 1024 * 1024; // <600MB is risky for RN APKs
          return `${d} (/data free: ${fmtBytes(free)}${low ? ' ⚠ low' : ''})`;
        }),
      );
      const anyLowSpace = deviceDetails.some((d) => d.includes('⚠ low'));
      checks.push({
        name: 'device-online',
        ok: devices.length > 0,
        detail: devices.length ? deviceDetails.join(', ') : 'no device/emulator online',
        fix: devices.length
          ? anyLowSpace
            ? 'Low /data space — reboot the emulator with `-wipe-data -partition-size 8192` before installing large RN APKs.'
            : undefined
          : 'Boot an emulator (qa_prepare_target will offer to), then re-run.',
      });

      const hasEmulator = await which('emulator');
      const avds = hasEmulator ? await listAvds() : [];
      checks.push({
        name: 'emulator+avd',
        ok: hasEmulator && avds.length > 0,
        optional: devices.length > 0, // not needed if a device is already online
        detail: hasEmulator ? (avds.length ? `AVDs: ${avds.join(', ')}` : 'emulator present, no AVDs') : 'emulator not on PATH',
        fix:
          hasEmulator && avds.length === 0
            ? 'Create an AVD: sdkmanager "system-images;android-35;google_apis;arm64-v8a" && avdmanager create avd -n qa -k "system-images;android-35;google_apis;arm64-v8a"'
            : hasEmulator
              ? undefined
              : 'Install the Android Emulator package via sdkmanager.',
      });

      const java = await firstLine('java', ['-version']);
      checks.push({
        name: 'java',
        ok: java !== null,
        optional: true, // only needed for build-from-source / a native backend (later phases)
        detail: java ?? 'not found (only needed for build-from-source / a native backend)',
      });

      const requiredOk = checks.filter((c) => !c.optional).every((c) => c.ok);
      const clientHint = client ? CLIENT_HINTS[client] : undefined;

      const table = checks
        .map((c) => `${c.ok ? '✅' : c.optional ? '⚠️ ' : '❌'} ${c.name}: ${c.detail}${c.fix && !c.ok ? `  → ${c.fix}` : ''}`)
        .join('\n');

      const summary =
        `Swipium v${SWIPIUM_VERSION} · ${TOOL_COUNT} tools · schema ${schemaHash}\n${STALE_CLIENT_HINT}\n\n` +
        `${requiredOk ? 'Environment ready for Android QA.' : 'Environment NOT ready — see ❌ rows.'}\n${table}`;

      return qaOk(
        {
          swipiumVersion: SWIPIUM_VERSION,
          schemaHash,
          toolSurface: { count: TOOL_COUNT, tools: TOOL_NAMES },
          ready: requiredOk,
          clientFreshness:
            expectedToolCount != null || expectedVersion != null || expectedSchemaHash != null
              ? { stale: versionMismatch || toolCountMismatch || schemaHashMismatch, runningVersion: SWIPIUM_VERSION, runningToolCount: TOOL_COUNT, runningSchemaHash: schemaHash, expectedVersion: expectedVersion ?? null, expectedToolCount: expectedToolCount ?? null, expectedSchemaHash: expectedSchemaHash ?? null }
              : undefined,
          checks,
          devicesOnline: devices,
          avds,
          ...(clientHint ? { clientHint } : {}),
        },
        summary,
      );
    },
  );
}
