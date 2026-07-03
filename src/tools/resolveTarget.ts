// qa_resolve_target (roadmap §5) — gather live device/simulator/artifact inputs and pick the
// best target with an explained reason, alternatives, preconditions, and whether a boot is
// needed. Pure decision logic lives in src/core/targetPlan.ts.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { resolveProjectRoot } from '../context/projectRoot.js';
import { adbDevices, listAvds, which } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { planTarget, type TargetInputs } from '../core/targetPlan.js';
import type { SessionStore } from '../session/store.js';

export function registerResolveTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_resolve_target',
    {
      title: 'Resolve the best test target',
      description:
        'Choose the best device/simulator to test on, deterministically: honors an explicit platform/device, respects a platform-specific artifact, prefers an already-online device (fastest), falls back to booting an emulator/simulator, and uses a real device only when requested. Returns the selection, a human reason, alternatives, preconditions (e.g. WDA/signing), and willBoot. Side-effect free (does not boot anything — qa_prepare_target / qa_ios do that).',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        platform: z.enum(['android', 'ios']).optional(),
        device: z.string().optional().describe('Explicit adb serial / simulator udid or name / AVD name.'),
        preferRealDevice: z.boolean().optional(),
      },
    },
    async ({ sessionId, projectRoot, platform, device, preferRealDevice }) => {
      let root: string | undefined;
      if (sessionId) root = sessions.get(sessionId)?.root;
      if (!root) {
        const resolved = await resolveProjectRoot(server, projectRoot);
        if (!resolved.root)
          return qaError({
            what: 'Could not resolve a project root',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Pass projectRoot or call qa_start_session.'],
            clientHint: resolved.hint,
          });
        root = resolved.root;
      }

      // Gather live inputs in parallel.
      const [adbPresent, simPresent] = await Promise.all([which('adb'), simctlAvailable()]);
      const [online, avds, sims] = await Promise.all([
        adbPresent ? adbDevices() : Promise.resolve<string[]>([]),
        adbPresent ? listAvds() : Promise.resolve<string[]>([]),
        simPresent ? listSimulators() : Promise.resolve([]),
      ]);
      // The artifact (best-effort) tells us the platform constraint — never fail on this.
      const art = await resolveArtifact({ projectRoot: root, platform: platform ?? 'any' }, false).catch(() => null);

      const inputs: TargetInputs = {
        requestedPlatform: platform,
        requestedDevice: device,
        preferRealDevice,
        artifactPlatform: art?.best?.platform,
        artifactInstallTargets: art?.best?.installableOn,
        android: { online, avds },
        ios: {
          bootedSimulators: sims.filter((s) => s.state === 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
          availableSimulators: sims.filter((s) => s.state !== 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
        },
        wdaAvailable: undefined, // unknown without probing — surfaced as a precondition
      };

      const plan = planTarget(inputs);
      if (plan.blocked) {
        return qaFail(plan.blocked.failureCode, {
          what: plan.blocked.detail,
          extra: { targetPlan: plan, artifactPlatform: inputs.artifactPlatform ?? null },
        });
      }

      const summary =
        `selected: ${plan.selected}${plan.device ? ` (${plan.device})` : ''}\n` +
        `reason: ${plan.reason}\n` +
        (plan.willBoot ? `willBoot: yes${plan.bootTarget ? ` → ${plan.bootTarget}` : ''}\n` : 'willBoot: no\n') +
        (plan.alternatives.length ? `alternatives: ${plan.alternatives.join(', ')}\n` : '') +
        (plan.preconditions.length ? `preconditions: ${plan.preconditions.join('; ')}` : 'preconditions: none');

      return qaOk({ ...plan, artifactPlatform: inputs.artifactPlatform ?? null }, summary);
    },
  );
}
