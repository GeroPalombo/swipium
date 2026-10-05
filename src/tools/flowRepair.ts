import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk, unknownSessionError } from '../lib/result.js';
import { parseSnapshot, signature } from '../snapshot/parse.js';
import { repairFlow } from '../flows/repair.js';
import { blockedDeviceResult, getDriver } from '../session/attach.js';
import type { LocatorPlatform } from '../oracle/locator.js';
import type { SessionStore } from '../session/store.js';

export function registerFlowRepair(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_flow_repair',
    {
      title: 'Repair a failed flow step',
      description:
        'For a failed flow step, suggest a stronger locator and app changes (testID/accessibilityIdentifier); apply:true ' +
        'patches simple selector steps at high/medium confidence (low confidence: refused, applied:false + a note).',
      inputSchema: {
        sessionId: z.string(),
        flow: z.string().optional().describe('Flow name/path under .swipium/flows.'),
        flowYaml: z.string().optional().describe('Inline flow YAML.'),
        failedStep: z.number().int().min(0).describe('Zero-based failed step index from qa_flow_run.failedAtStep.'),
        apply: z.boolean().optional().describe('Patch the flow file when safe (default false).'),
      },
    },
    async ({ sessionId, flow, flowYaml, failedStep, apply }) => {
      const session = sessions.get(sessionId);
      if (!session) return unknownSessionError(sessionId);
      const { driver, blocked } = await getDriver(session);
      if (!session || !driver)
        return (
          blockedDeviceResult(blocked) ??
          qaError({
            what: 'No device attached to this session',
            changedState: false,
            retrySafe: true,
            nextSteps: ['Call qa_prepare_target / qa_ios + qa_wda first.'],
          })
        );
      if (driver.kind === 'simulator' || session.mode === 'visual-fallback') {
        return qaError({
          what: 'Flow repair needs a structured UI tree',
          changedState: false,
          retrySafe: false,
          failureCode: 'BACKEND_UNSUPPORTED',
          nextSteps: ['For visual-only iOS simctl flows, repair image/visual checkpoints manually or attach WDA with qa_wda.'],
        });
      }
      let xml: string;
      try {
        xml = await driver.dumpXml();
      } catch (e) {
        return qaError({
          what: `Could not read current UI tree: ${String(e)}`,
          changedState: false,
          retrySafe: true,
          failureCode: 'SNAPSHOT_FAILED',
          nextSteps: ['Settle the app and retry qa_flow_repair.'],
        });
      }
      const parsed = parseSnapshot(xml, { interactiveOnly: false });
      session.lastSnapshot = {
        fullByRef: parsed.fullByRef,
        signatures: new Set(parsed.elements.map(signature)),
        allNodes: parsed.allNodes,
      };
      const platform: LocatorPlatform =
        driver.kind === 'wda' ? 'ios' : driver.kind === 'direct' || driver.kind === 'remote' ? 'android' : 'generic';
      const repaired = repairFlow({ root: session.root, flow, flowYaml, failedStep, elements: parsed.elements, apply, platform });
      if ('error' in repaired)
        return qaError({
          what: repaired.error,
          changedState: false,
          retrySafe: true,
          ...(repaired.errorCode === 'PATH_OUTSIDE_ROOT' ? { failureCode: 'UNSAFE_ACTION_REFUSED' as const } : {}),
          nextSteps: [
            repaired.errorCode === 'PATH_OUTSIDE_ROOT'
              ? 'Pass a flow name or a path under the project root (.swipium/flows/*.yaml).'
              : 'Pass a valid flow and failedStep from qa_flow_run.',
          ],
        });
      const proposalArtifactUri = repaired.proposal
        ? sessions.saveArtifact(
            session,
            'repair',
            `flow-repair-${repaired.flow.replace(/[^a-z0-9_.-]+/gi, '_').slice(0, 40) || 'flow'}-${failedStep}-${Date.now()}.json`,
            JSON.stringify(repaired.proposal, null, 2),
            'application/json',
            `Reviewable flow repair proposal for ${repaired.flow} step ${failedStep}`,
          )
        : undefined;
      if (repaired.patched) {
        sessions.recordMutation(session, {
          tool: 'qa_flow_repair',
          action: 'apply_repair_proposal',
          risk: 'low',
          target: { source: repaired.source, flow: repaired.flow, failedStep, proposalArtifactUri },
          consent: { required: false, approved: true },
          status: 'executed',
          detail: 'Applied a reviewable flow repair proposal to the source flow file.',
        });
      }
      const s = repaired.suggestions[0];
      const summary =
        `repair for "${repaired.flow}" step ${failedStep}: ${s.replacementSelector ? `try "${s.replacementSelector}"` : 'no replacement selector found'} (${s.confidence} confidence)` +
        `${s.appCodeSuggestion ? `\napp change: ${s.appCodeSuggestion}` : ''}` +
        `${proposalArtifactUri ? `\nproposal: ${proposalArtifactUri}` : ''}` +
        `${repaired.patched ? `\npatched ${repaired.source}` : ''}` +
        `${repaired.notes?.length ? `\n${repaired.notes.join('\n')}` : ''}`;
      return qaOk({ ...repaired, proposalArtifactUri }, summary);
    },
  );
}
