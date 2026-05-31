// qa_report — thin wrapper around the report service (Phase 3.2 Milestone B). All assembly lives in
// src/services/report.ts so qa_test_this execute produces the identical report artifact in every
// terminal state. This tool resolves the session, runs the service, and surfaces its result.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError } from '../lib/result.js';
import { generateSessionReport } from '../services/report.js';
import type { SessionStore } from '../session/store.js';

export function registerReport(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_report',
    {
      title: 'Build a session report',
      description:
        'Assemble a report for the session: an executive summary (release risk ship/caution/block + the single next action), native/app health, structured outcomes by workflow, findings, artifact links, env mutations + restoration, workarounds + provided inputs. Returns a summary + resource URIs (not the whole bundle); saves the full report as an artifact. Pass `format` to also export: markdown (issue-ready), json, junit (CI), playwright (dashboard JSON), or flow — returns the export artifact URI. qa_test_this execute generates this report automatically at the end of a run.',
      inputSchema: {
        sessionId: z.string(),
        format: z.enum(['summary', 'markdown', 'json', 'junit', 'flow', 'playwright']).optional().describe('Also emit this export as an artifact (default summary only). markdown = issue-ready; junit = CI; playwright = Playwright-style dashboard JSON; flow = a replayable flow drafted from the actions recorded this run.'),
        baseline: z.string().optional().describe('Optional baseline report.json path. When provided, qa_report adds comparison and PR-summary links.'),
        trendRoot: z.string().optional().describe('Optional project root containing .swipium/runs or legacy .swipium/ci history. When provided, qa_report adds trend/flake context.'),
      },
    },
    async ({ sessionId, format, baseline, trendRoot }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first.'] });
      }

      // format:"flow" with no recorded actions is a user error (kept from the original tool).
      if (format === 'flow' && !session.recordedActions.length) {
        return qaError({ what: 'No actions were recorded this run, so there is no flow to export', changedState: false, retrySafe: true, nextSteps: ['Drive the app with qa_act first, then qa_report { format: "flow" } — or use qa_flow_generate.'] });
      }

      const r = await generateSessionReport(sessions, session, {
        format,
        baseline,
        trendRoot,
      });
      return qaOk(
        {
          ...r.report,
          reportUri: r.reportUri,
          manifestUri: r.manifestUri,
          manifest: r.manifest,
          dumpUri: r.dumpUri,
          ...(r.reportLinks ? { reportLinks: r.reportLinks } : {}),
          ...(r.exportUri ? { exportUri: r.exportUri, exportFormat: r.exportFormat } : {}),
        },
        r.summaryText,
      );
    },
  );
}
