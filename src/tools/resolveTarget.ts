// qa_resolve_target (roadmap §5) — gather live device/simulator/artifact inputs and pick the
// best target with an explained reason, alternatives, preconditions, and whether a boot is
// needed. Pure decision logic lives in src/core/targetPlan.ts. `include` folds in what used to be
// qa_detect_context (project context: framework, artifacts, Android devices + iOS simulators,
// toolchain, blockers) and qa_plan (READY / BLOCKED / UNSAFE workflows, src/plan/plan.ts).

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk } from '../lib/result.js';
import { qaFail } from '../oracle/failures.js';
import { resolveProjectRoot, unresolvedProjectRootError } from '../context/projectRoot.js';
import { adbDevices, listAvds, which } from '../lib/android.js';
import { simctlAvailable, listSimulators } from '../lib/simctl.js';
import { resolveArtifact } from '../artifacts/resolve.js';
import { planTarget, type TargetInputs } from '../core/targetPlan.js';
import { detectContext, hasAnyDevice, type DetectedContext } from '../context/detect.js';
import { buildPlan, type Plan } from '../plan/plan.js';
import { listFlowFiles } from '../flows/discover.js';
import { verifiedEmulatorSerials } from '../session/attach.js';
import { loadProjectFixtures } from './startSession.js';
import type { Session, SessionStore } from '../session/store.js';

/** READY / BLOCKED / UNSAFE workflows for `root`, informed by the session's declared fixtures,
 *  observed auth, and prepared app when there is one (else .swipium/fixtures.json). Exported for tests. */
export function workflowPlan(ctx: DetectedContext, root: string, session?: Session): Plan & { framework: string } {
  const plan = buildPlan({
    framework: ctx.framework,
    // A booted/bootable iOS simulator counts — iOS workflows are not missing_device.
    hasDevice: hasAnyDevice(ctx.devices),
    hasApk: ctx.artifacts.apks.length > 0 || ctx.artifacts.ipas.length > 0 || ctx.artifacts.appBundles.length > 0,
    appPrepared: !!session?.appId,
    fixtures: session?.fixtures ?? loadProjectFixtures(root),
    auth: session?.auth ?? {},
    blockers: ctx.blockers,
    flows: listFlowFiles(root).map((f) => f.name),
  });
  return { ...plan, framework: ctx.framework };
}

function contextSummary(ctx: DetectedContext): string {
  return (
    `\ncontext: framework=${ctx.framework} location=${ctx.location} monorepo=${ctx.monorepo}; ` +
    `artifacts ${ctx.artifacts.apks.length} apk / ${ctx.artifacts.ipas.length} ipa / ${ctx.artifacts.appBundles.length} .app; ` +
    `android online=[${ctx.devices.androidOnline.join(', ')}] avds=[${ctx.devices.avds.join(', ')}]; ` +
    `iosBooted=[${ctx.devices.iosBooted.map((d) => d.name).join(', ')}] iosAvailable=${ctx.devices.iosAvailable.length}` +
    (ctx.blockers.length ? `\nblockers:\n - ${ctx.blockers.join('\n - ')}` : '')
  );
}

function planSummary(plan: Plan): string {
  const line = (x: string) => ` - ${x}`;
  return (
    `\nplan READY (${plan.ready.length}): ${plan.ready.map((w) => `${w.workflow} [${w.budgetProfile}]`).join(', ') || '(none)'}` +
    (plan.blocked.length
      ? `\nBLOCKED (${plan.blocked.length}):\n` +
        plan.blocked.map((w) => line(`${w.workflow}: ${w.category} — ${w.requiredState} → ${w.recommendedSetup}`)).join('\n')
      : '') +
    (plan.unsafe.length
      ? `\nUNSAFE (${plan.unsafe.length}):\n` + plan.unsafe.map((w) => line(`${w.workflow}: ${w.reason} — ${w.detail}`)).join('\n')
      : '')
  );
}

export function registerResolveTarget(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_resolve_target',
    {
      title: 'Resolve the best test target',
      description:
        'Pick the best device/simulator deterministically: honors platform/device and a platform-specific artifact, prefers an ' +
        'online emulator/simulator, else plans a boot; physical devices → PHYSICAL_DEVICE_UNSUPPORTED. Returns selected, ' +
        'reason, alternatives, preconditions, willBoot. include:["context"] adds framework, artifacts, Android devices + iOS ' +
        'simulators, toolchain, blockers; include:["plan"] adds READY / BLOCKED / UNSAFE workflows (session fixtures/auth when ' +
        'sessionId is given). Boots nothing.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional(),
        platform: z.enum(['android', 'ios']).optional(),
        device: z.string().optional().describe('Explicit adb serial / simulator udid or name / AVD name.'),
        preferRealDevice: z.boolean().optional().describe('Out of scope: returns PHYSICAL_DEVICE_UNSUPPORTED.'),
        include: z
          .array(z.enum(['context', 'plan']))
          .optional()
          .describe('Extra sections: context, plan.'),
      },
    },
    async ({ sessionId, projectRoot, platform, device, preferRealDevice, include }) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      let root: string | undefined = session?.root;
      if (!root) {
        const resolved = await resolveProjectRoot(server, projectRoot);
        if (!resolved.root) return unresolvedProjectRootError(resolved);
        root = resolved.root;
      }

      // Gather live inputs in parallel.
      const [adbPresent, simPresent] = await Promise.all([which('adb'), simctlAvailable()]);
      const [online, avds, sims] = await Promise.all([
        adbPresent ? adbDevices() : Promise.resolve<string[]>([]),
        adbPresent ? listAvds() : Promise.resolve<string[]>([]),
        simPresent ? listSimulators() : Promise.resolve([]),
      ]);
      // H6: property-verified emulators (localhost:5555, Genymotion) — same policy as getDriver.
      const emulators = await verifiedEmulatorSerials(online);
      // The artifact (best-effort) tells us the platform constraint — never fail on this.
      const art = await resolveArtifact({ projectRoot: root, platform: platform ?? 'any' }, false).catch(() => null);

      const inputs: TargetInputs = {
        requestedPlatform: platform,
        requestedDevice: device,
        preferRealDevice,
        artifactPlatform: art?.best?.platform,
        artifactInstallTargets: art?.best?.installableOn,
        android: { online, avds, emulators },
        ios: {
          bootedSimulators: sims.filter((s) => s.state === 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
          availableSimulators: sims.filter((s) => s.state !== 'Booted').map((s) => ({ udid: s.udid, name: s.name })),
        },
        wdaAvailable: undefined, // unknown without probing — surfaced as a precondition
      };

      const plan = planTarget(inputs);
      const wants = new Set(include ?? []);
      const ctx = wants.size ? await detectContext(root) : undefined;
      const extras: { context?: DetectedContext; plan?: Plan & { framework: string } } = {};
      if (ctx && wants.has('context')) extras.context = ctx;
      if (ctx && wants.has('plan')) extras.plan = workflowPlan(ctx, root, session);
      if (plan.blocked) {
        return qaFail(plan.blocked.failureCode, {
          what: plan.blocked.detail,
          extra: { targetPlan: plan, artifactPlatform: inputs.artifactPlatform ?? null, ...extras },
        });
      }

      const summary =
        `selected: ${plan.selected}${plan.device ? ` (${plan.device})` : ''}\n` +
        `reason: ${plan.reason}\n` +
        (plan.willBoot ? `willBoot: yes${plan.bootTarget ? ` → ${plan.bootTarget}` : ''}\n` : 'willBoot: no\n') +
        (plan.alternatives.length ? `alternatives: ${plan.alternatives.join(', ')}\n` : '') +
        (plan.preconditions.length ? `preconditions: ${plan.preconditions.join('; ')}` : 'preconditions: none') +
        (extras.context ? contextSummary(extras.context) : '') +
        (extras.plan ? planSummary(extras.plan) : '');

      return qaOk({ ...plan, artifactPlatform: inputs.artifactPlatform ?? null, ...extras }, summary);
    },
  );
}
