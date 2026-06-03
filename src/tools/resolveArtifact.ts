// qa_resolve_artifact (roadmap §4.2) — find the best installable build for the project, wherever
// it lives, and explain exactly where Swipium looked. Wraps src/artifacts/resolve.ts and returns
// a typed NO_BUILD_ARTIFACT / AAB_NEEDS_BUNDLETOOL / outside-root blocker instead of guessing.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { resolveArtifact, type InstallTarget } from '../artifacts/resolve.js';
import { qaNeedsInput, NeedsInput } from '../lib/needsInput.js';
import type { SessionStore } from '../session/store.js';

export function registerResolveArtifact(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_resolve_artifact',
    {
      title: 'Resolve a build artifact',
      description:
        'Find the best installable app build (.apk/.aab/.ipa/.app) for the project — searching Gradle/Flutter/Xcode output trees and (opt-in) Xcode DerivedData, not just the project root. Returns ranked candidates with build type, installability, app/bundle id, native ABIs, warnings, and the EXACT locations searched. Typed blockers: NO_BUILD_ARTIFACT (with where it looked), AAB_NEEDS_BUNDLETOOL, ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL. Side-effect free (never installs/builds).',
      inputSchema: {
        sessionId: z.string().optional().describe("Use this session's projectRoot if given."),
        projectRoot: z.string().optional().describe('Absolute path; else resolved via MCP roots.'),
        platform: z.enum(['android', 'ios', 'any']).optional(),
        buildType: z.enum(['debug', 'release', 'any']).optional(),
        path: z.string().optional().describe('Explicit artifact path — short-circuits the search.'),
        allowOutsideRoot: z.boolean().optional().describe('Allow a best candidate outside the project root (downloads/DerivedData).'),
        requireInstallableOn: z.enum(['android-emulator', 'android-real', 'ios-simulator', 'ios-real']).optional(),
      },
    },
    async ({ sessionId, projectRoot, platform, buildType, path, allowOutsideRoot, requireInstallableOn }) => {
      let root: string | undefined;
      if (sessionId) root = sessions.get(sessionId)?.root;
      if (!root) {
        const resolved = await resolveProjectRoot(server, projectRoot);
        if (!resolved.root) {
          return qaError({ what: 'Could not resolve a project root', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot="/abs/path", or call qa_start_session first.'], clientHint: resolved.hint });
        }
        root = resolved.root;
      }

      const result = await resolveArtifact({
        projectRoot: root,
        platform,
        buildType,
        explicitPath: path,
        allowOutsideRoot,
        requireInstallableOn: requireInstallableOn as InstallTarget | undefined,
      });

      if (result.failureCode === 'ARTIFACT_OUTSIDE_ROOT_REQUIRES_APPROVAL') {
        const outside = result.candidates.find((c) => c.outsideRoot);
        return qaNeedsInput(NeedsInput.artifactOutsideRoot(outside?.path ?? '(outside root)'), {
          sessionId: sessionId ?? null,
          candidates: result.candidates.slice(0, 5),
          searchedLocations: result.searchedLocations,
        });
      }

      if (result.failureCode) {
        return qaFail(result.failureCode, {
          what:
            result.failureCode === 'NO_BUILD_ARTIFACT'
              ? `No installable artifact found under ${root}`
              : result.warnings[0],
          nextSteps: [
            ...(result.warnings.length ? result.warnings : []),
            'Build from source: qa_build_plan → qa_build.',
            `Searched: ${result.searchedLocations.slice(0, 8).join('; ')}${result.searchedLocations.length > 8 ? ' …' : ''}`,
          ],
          extra: { searchedLocations: result.searchedLocations, candidates: result.candidates.slice(0, 5) },
        });
      }

      const best = result.best!;
      const summary =
        `Best: ${best.type.toUpperCase()} ${best.path}\n` +
        `platform=${best.platform} buildType=${best.buildType} installableOn=[${best.installableOn.join(', ')}]` +
        (best.appId ? ` appId=${best.appId}` : '') +
        (best.abis?.length ? ` abis=[${best.abis.join(',')}]` : '') +
        `\ncandidates: ${result.candidates.length} (top ${Math.min(5, result.candidates.length)} returned)` +
        (best.warnings.length ? `\n⚠ ${best.warnings.join('; ')}` : '') +
        (result.warnings.length ? `\nnote: ${result.warnings.join('; ')}` : '');

      return qaOk(
        {
          best,
          newest: result.newest,
          candidates: result.candidates.slice(0, 5),
          searchedLocations: result.searchedLocations,
          warnings: result.warnings,
        },
        summary,
      );
    },
  );
}
