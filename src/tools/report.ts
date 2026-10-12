// qa_report: thin wrapper around the report service (Phase 3.2 Milestone B). All assembly lives in
// src/services/report.ts so qa_test_this execute produces the identical report artifact in every
// terminal state. This tool resolves the session, runs the service, and surfaces its result.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { currentResponseMode, qaOk, qaError, unknownSessionError } from '../lib/result.js';
import { generateSessionReport } from '../services/report.js';
import type { SessionStore } from '../session/store.js';

export function registerReport(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_report',
    {
      title: 'Build a session report',
      description:
        'Build the session report (release risk, health, outcomes, findings, evidence, env changes) as an artifact; returns a ' +
        'summary + URIs (read reportMdUri, report.md; the full JSON is reportUri, inline with format:"json"). format adds an export: markdown, json, junit, sarif, github-summary, playwright, or flow. ' +
        'qa_test_this execute calls it for you. CI: docs/ci-reports.md.',
      inputSchema: {
        sessionId: z.string(),
        format: z.enum(['summary', 'markdown', 'json', 'junit', 'sarif', 'github-summary', 'flow', 'playwright']).optional(),
        baseline: z.string().optional().describe('Baseline report.json path; adds comparison links.'),
        trendRoot: z.string().optional().describe('Project root with run history; adds trends/flakes.'),
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
          nextSteps: ['Drive the app with qa_act first, then qa_report { format: "flow" }, or use qa_generate target:"flow".'],
        });
      }

      const r = await generateSessionReport(sessions, session, {
        format,
        baseline,
        trendRoot,
      });
      // structuredContent is what Claude Code / Codex hand the model: the lean view (verdicts,
      // executive + PR summary, counts, URIs) plus the full summary text. The whole report is
      // the report.json artifact, or inline with format:"json" / verbose response mode.
      const rep = r.report as Record<string, unknown>;
      const full = format === 'json' || currentResponseMode() === 'verbose';
      const links = r.reportLinks ? { ...r.reportLinks, prSummary: undefined } : undefined;
      const uris = {
        reportMdUri: r.reportMdUri,
        reportUri: r.reportUri,
        manifestUri: r.manifestUri,
        ...(r.dumpUri ? { dumpUri: r.dumpUri } : {}),
        ...(r.exportUri ? { exportUri: r.exportUri, exportFormat: r.exportFormat } : {}),
      };
      if (full)
        return qaOk({ ...rep, ...uris, manifest: r.manifest, ...(r.reportLinks ? { reportLinks: r.reportLinks } : {}) }, r.summaryText);
      const findings = (rep.findings as unknown[] | undefined) ?? [];
      return qaOk(
        {
          sessionId: rep.sessionId,
          appId: rep.appId,
          device: rep.device,
          executiveSummary: rep.executiveSummary,
          appVerdict: rep.appVerdict,
          coverageVerdict: rep.coverageVerdict,
          toolVerdict: rep.toolVerdict,
          prSummary: rep.prSummary,
          counts: {
            findings: findings.length,
            findingOccurrences: rep.findingOccurrences,
            highSeverity: rep.highSeverityCount,
            toolErrors: ((rep.toolErrors as unknown[] | undefined) ?? []).length,
            outcomes: rep.outcomeTally,
            // LOG-8: the run test catalog (outcomes + finding/exploration-derived cases), the
            // "test catalog: N case(s)" the summary prints; `outcomes` counts qa_note outcomes only.
            testCatalog: (rep.runTestCatalog as { counts?: unknown } | undefined)?.counts,
            // Same count as the summary's "artifacts: N" (report.json + manifest included; report.md,
            // which holds that summary, is saved after it).
            artifacts: session.artifacts.filter((art) => art.uri !== r.reportMdUri).length,
          },
          ...uris,
          // Always present (docs/tools.md#qa_report); null without baseline/trendRoot.
          reportLinks: links ?? null,
        },
        r.summaryText,
        { structuredSummary: 'full' },
      );
    },
  );
}
