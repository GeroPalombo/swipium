// qa_report — thin wrapper around the report service (Phase 3.2 Milestone B). All assembly lives in
// src/services/report.ts so qa_test_this execute produces the identical report artifact in every
// terminal state. This tool resolves the session, runs the service, and surfaces its result.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { generateSessionReport } from '../services/report.js';
import type { SessionStore } from '../session/store.js';

export function registerReport(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_report',
    {
      title: 'Build a session report',
      description:
        'Assemble the session report: executive summary (release risk ship/caution/block + next action), health, outcomes by ' +
        'workflow, findings, evidence links, env changes + restoration, workarounds. Saves the full report as an artifact and returns ' +
        'a summary + URIs. format adds an export artifact: markdown, json, junit, sarif (SARIF 2.1.0), github-summary, playwright, or ' +
        'flow. qa_test_this execute calls this automatically. CI usage: docs/ci-reports.md.',
      inputSchema: {
        sessionId: z.string(),
        format: z.enum(['summary', 'markdown', 'json', 'junit', 'sarif', 'github-summary', 'flow', 'playwright']).optional(),
        baseline: z.string().optional().describe('Baseline report.json path → adds comparison links.'),
        trendRoot: z.string().optional().describe('Project root with .swipium/runs history → adds trend/flake context.'),
      },
    },
    async ({ sessionId, format, baseline, trendRoot }) => {
      const session = sessions.get(sessionId);
      if (!session) {
        return unknownSessionError(sessionId);
      }

      // format:"flow" with no recorded actions is a user error (kept from the original tool).
      if (format === 'flow' && !session.recordedActions.length) {
        return qaError({
          what: 'No actions were recorded this run, so there is no flow to export',
          changedState: false,
          retrySafe: true,
          nextSteps: ['Drive the app with qa_act first, then qa_report { format: "flow" } — or use qa_generate target:"flow".'],
        });
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
