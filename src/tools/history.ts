import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { qaError, qaOk } from '../lib/result.js';
import { compareReports, trendForRoot } from '../report/history.js';
import type { SessionStore } from '../session/store.js';

export function registerHistory(server: McpServer, sessions: SessionStore): void {
  server.registerTool(
    'qa_report_compare',
    {
      title: 'Compare Swipium reports',
      description:
        'Compare a current Swipium report.json against a baseline report.json. Reports new failures, fixed failures, changed screenshots, outcome changes, runtime regression, and optional flake status from local trend history.',
      inputSchema: {
        current: z.string().describe('Path to current report.json.'),
        baseline: z.string().describe('Path to baseline report.json.'),
        trendRoot: z.string().optional().describe('Optional project root containing .swipium/runs or legacy .swipium/ci history for known-flaky classification.'),
      },
    },
    async ({ current, baseline, trendRoot }) => {
      try {
        const cmp = compareReports(current, baseline, { trendRoot });
        return qaOk(cmp as unknown as Record<string, unknown>, cmp.summary);
      } catch (e) {
        return qaError({ what: `Could not compare reports: ${String((e as Error).message ?? e)}`, changedState: false, retrySafe: true, nextSteps: ['Pass readable Swipium report.json files for current and baseline.'] });
      }
    },
  );

  server.registerTool(
    'qa_run_history',
    {
      title: 'Summarize Swipium run history',
      description:
        'Read local .swipium/runs/**/report.json files (and legacy .swipium/ci/**) and summarize pass rate, median runtime, top failures, environment failures, flaky flows, confidence calibration, and slowest runs.',
      inputSchema: {
        sessionId: z.string().optional(),
        projectRoot: z.string().optional().describe('Project root. Defaults to the session root when sessionId is provided.'),
      },
    },
    async ({ sessionId, projectRoot }) => {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !session) return qaError({ what: `Unknown sessionId ${sessionId}`, changedState: false, retrySafe: true, nextSteps: ['Call qa_start_session first, or pass projectRoot.'] });
      const root = projectRoot ?? session?.root;
      if (!root) return qaError({ what: 'qa_run_history needs projectRoot or sessionId', changedState: false, retrySafe: true, nextSteps: ['Pass projectRoot, or call qa_start_session first.'] });
      try {
        const trend = trendForRoot(root);
        const calibration = trend.confidenceCalibration;
        const blockers = trend.releaseGateSignals.filter((s) => s.level === 'block').reduce((sum, s) => sum + s.count, 0);
        const warnings = trend.releaseGateSignals.filter((s) => s.level === 'warn').reduce((sum, s) => sum + s.count, 0);
        const locatorTrend = trend.locatorReadinessTrend;
        const summary =
          `history: ${trend.reports} report(s), median ${trend.medianRuntimeSec ?? 'n/a'}s\n` +
          `timing: avg setup ${trend.averageSetupSec ?? 'n/a'}s, avg active ${trend.averageActiveSec ?? 'n/a'}s\n` +
          (locatorTrend.runsWithReadiness ? `locator readiness: latest durable ${locatorTrend.latestDurablePct ?? 'n/a'}%, average ${locatorTrend.averageDurablePct ?? 'n/a'}%\n` : '') +
          Object.entries(trend.passRate).map(([flow, rate]) => `  ${flow}: ${(rate * 100).toFixed(1)}% pass`).join('\n') +
          `\nrelease gate signals: ${blockers} block, ${warnings} warn` +
          `\ncalibration: ${calibration.status} (${calibration.confidenceSamples}/${calibration.probabilisticEvidence} confidence sample(s), ${calibration.outcomeSamples} outcome sample(s))` +
          (trend.slowestSteps.length ? `\nslowest step: ${trend.slowestSteps[0].workflow}#${trend.slowestSteps[0].index} ${trend.slowestSteps[0].kind} ${trend.slowestSteps[0].durationSec}s` : '');
        return qaOk({ root, ...trend }, summary);
      } catch (e) {
        return qaError({ what: `Could not read run history: ${String((e as Error).message ?? e)}`, changedState: false, retrySafe: true, nextSteps: ['Confirm .swipium/runs or .swipium/ci contains report.json files.'] });
      }
    },
  );
}
