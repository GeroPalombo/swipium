// qa_detect_context — scan the resolved projectRoot and report what we're looking at.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { detectContext } from '../context/detect.js';
import type { SessionStore } from '../session/store.js';

export function registerDetectContext(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_detect_context',
    {
      title: 'Detect project context',
      description:
        'Scan the resolved project root (a session root, an explicit projectRoot, or MCP workspace roots — never the server cwd) and report: framework (expo/bare-rn/native-android/native-ios/flutter), monorepo, prebuilt artifacts (apk/ipa/.app), online devices + AVDs, toolchain, and blockers. Use this to decide what qa_prepare_target needs.',
      inputSchema: {
        sessionId: z.string().optional().describe('Use this session\'s projectRoot if given.'),
        projectRoot: z.string().optional().describe('Absolute path; else resolved via MCP roots.'),
      },
    },
    async ({ sessionId, projectRoot }) => {
      let root: string | undefined;
      if (sessionId) root = sessions.get(sessionId)?.root;
      if (!root) {
        const resolved = await resolveProjectRoot(server, projectRoot);
        if (!resolved.root) {
          return qaError({
            what: 'Could not resolve a project root to scan',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass projectRoot="/abs/path", or call qa_start_session first.'],
            clientHint: resolved.hint,
          });
        }
        root = resolved.root;
      }

      const ctx = await detectContext(root);
      const summary =
        `root=${ctx.projectRoot}\n` +
        `framework=${ctx.framework} location=${ctx.location} monorepo=${ctx.monorepo}\n` +
        `artifacts: ${ctx.artifacts.apks.length} apk, ${ctx.artifacts.ipas.length} ipa, ${ctx.artifacts.appBundles.length} .app\n` +
        `devices: online=[${ctx.devices.androidOnline.join(', ')}] avds=[${ctx.devices.avds.join(', ')}]\n` +
        `toolchain: adb=${ctx.toolchain.adb} emulator=${ctx.toolchain.emulator} java=${ctx.toolchain.java} aapt2=${ctx.toolchain.aapt2} xcodebuild=${ctx.toolchain.xcodebuild}\n` +
        (ctx.blockers.length ? `blockers:\n - ${ctx.blockers.join('\n - ')}` : 'no blockers');
      return qaOk(ctx as unknown as Record<string, unknown>, summary);
    },
  );
}
